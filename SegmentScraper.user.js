// ==UserScript==
// @name         SegmentScraper - Multi-Provider Timestamps Extractor
// @namespace    https://github.com/mronion212/SegmentScraper
// @version      1.0.1
// @description  Extracts intro/recap/outro timestamps from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.
// @author       mronion212
// @match        https://www.netflix.com/*
// @match        https://www.disneyplus.com/*
// @match        https://www.amazon.com/*/detail/*
// @match        https://play.max.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      v3.sg.media-imdb.com
// @connect      api.introdb.app
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';
  const _GM_xmlhttpRequest = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null;
  const _unsafeWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;


  // ─── core/state.js ───

/**
 * Shared state management for SegmentScraper
 * Manages captured timestamps, UI state, and deduplication cache
 */

/**
 * Create a cache key for an episode
 * @param {string} imdbId - IMDb ID (e.g., 'tt1234567')
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @returns {string} - Cache key in format 'imdbId|season|episode'
 */
function createEpisodeCacheKey(imdbId, season, episode) {
  return `${String(imdbId)}|${String(season)}|${String(episode)}`;
}

/**
 * Create a cache key for a segment (includes segment type)
 * @param {string} imdbId - IMDb ID
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @param {string} segmentType - Segment type (intro, recap, outro)
 * @returns {string} - Cache key in format 'imdbId|season|episode|segment_type'
 */
function createSegmentCacheKey(imdbId, season, episode, segmentType) {
  return `${String(imdbId)}|${String(season)}|${String(episode)}|${segmentType}`;
}

const createState = (providerName) => ({
  allItems: [],
  imdbId: '',
  dbSearchDone: false,
  dbStatusMsg: `Waiting for ${providerName} metadata...`,
  showTitle: '',
  showId: null,
  showYear: '',
  interceptedCount: 0,
  panelVisible: false,
  submitInProgress: false,
  submitResults: { ok: 0, fail: 0 },
  dedupCacheV2: {},
  introdbApiKey: '',
});

const state = createState('Streaming Service');


  // ─── core/network.js ───

/**
 * Shared network utilities for SegmentScraper
 * Handles API requests, IMDb lookups, and IntroDB integration
 */
const INTRODB_BASE = 'https://api.introdb.app';

/**
 * Get GM_xmlhttpRequest if available (Tampermonkey/Greasemonkey)
 */
function getGmXhr() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) || 
         (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
         (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

/**
 * Search IMDb by title and return the best matching series ID
 */
async function searchImdbByTitle(title, year, apiKey) {
  const query = encodeURIComponent(title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${query}.json`;
  console.log('[NFE] IMDb search request URL:', url, 'for title:', title, 'year:', year);
  
  const gmXhr = getGmXhr();
  console.log('[NFE] GM_xmlhttpRequest available:', !!gmXhr, 'using fetch fallback');
  if (gmXhr) {
    return new Promise((resolve) => {
      gmXhr({
        method: 'GET',
        url: url,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.netflix.com'
        },
        onload: (response) => {
          console.log('[NFE] IMDb search response status:', response.status, 'responseText length:', response.responseText?.length);
          try {
            const data = JSON.parse(response.responseText);
            console.log('[NFE] IMDb search response data:', data);
            const results = (data.d || []).filter(r => r.qid === 'tvSeries' || r.qid === 'tvMiniSeries');
            console.log('[NFE] Filtered TV series results:', results.length);
          
            if (!results.length) {
              resolve({ success: false, error: 'Not found on IMDb' });
              return;
            }
            
            let best = results[0];
            if (year) {
              const byYear = results.find(r => String(r.y) === year && r.l.toLowerCase() === title.toLowerCase());
              const byYearApprox = results.find(r => String(r.y) === year);
              if (byYear) best = byYear;
              else if (byYearApprox) best = byYearApprox;
            } else {
              const exact = results.find(r => r.l.toLowerCase() === title.toLowerCase());
              if (exact) best = exact;
            }
            
            const imdbId = best.id;
            if (!imdbId || !imdbId.startsWith('tt')) {
              resolve({ success: false, error: 'Could not obtain a valid IMDb ID' });
              return;
            }
            
            resolve({ 
              success: true, 
              imdbId, 
              title: best.l, 
              year: best.y 
            });
          } catch (parseError) {
            console.error('[NFE] IMDb response parse error:', parseError);
            resolve({ success: false, error: 'Failed to parse IMDb response' });
          }
        },
        onerror: (error) => {
          console.error('[NFE] IMDb search error details:', JSON.stringify(error, null, 2));
          resolve({ success: false, error: 'Network error connecting to IMDb: ' + (error?.error || error?.status || error?.message || JSON.stringify(error)) });
        },
        ontimeout: () => {
          console.error('[NFE] IMDb search timeout');
          resolve({ success: false, error: 'IMDb search timeout' });
        }
      });
    });
  }
  
  console.log('[NFE] Using fetch fallback (may fail due to CORS)');
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log('[NFE] IMDb search response data:', data);
    const results = (data.d || []).filter(r => r.qid === 'tvSeries' || r.qid === 'tvMiniSeries');
    console.log('[NFE] Filtered TV series results:', results.length);
    
    if (!results.length) {
      return { success: false, error: 'Not found on IMDb' };
    }
    
    let best = results[0];
    if (year) {
      const byYear = results.find(r => String(r.y) === year && r.l.toLowerCase() === title.toLowerCase());
      const byYearApprox = results.find(r => String(r.y) === year);
      if (byYear) best = byYear;
      else if (byYearApprox) best = byYearApprox;
    } else {
      const exact = results.find(r => r.l.toLowerCase() === title.toLowerCase());
      if (exact) best = exact;
    }
    
    const imdbId = best.id;
    if (!imdbId || !imdbId.startsWith('tt')) {
      return { success: false, error: 'Could not obtain a valid IMDb ID' };
    }
    
    return { 
      success: true, 
      imdbId, 
      title: best.l, 
      year: best.y 
    };
  } catch (error) {
    console.error('[NFE] Fetch fallback error:', error);
    return { success: false, error: 'Network error connecting to IMDb (CORS or network issue)' };
  }
}

/**
 * Load existing segments from IntroDB for deduplication
 * Uses GM_xmlhttpRequest to avoid CORS issues
 * 
 * This function collects unique episode keys from the currently captured items
 * and calls /segments endpoint once per unique episode.
 * 
 * @param {string} imdbId - IMDb ID to load segments for
 * @param {string} apiKey - IntroDB API key (optional)
 * @returns {Promise<Array>} - Array of { key, segmentType } objects
 */
async function loadExistingSegments(imdbId, apiKey) {
  console.log('[NFE-DEDUP] loadExistingSegments called for imdbId:', imdbId);

  // Collect unique episode keys from currently captured items for this imdb_id
  const episodeKeys = [...new Set(
    state.allItems
      .filter(i => i.imdb_id === imdbId)
      .map(i => createEpisodeCacheKey(imdbId, i.season, i.episode))
  )];

  console.log('[NFE-DEDUP] loadExistingSegments: unique episode keys collected:', episodeKeys);

  // Load each episode's segments via /segments endpoint
  const results = await Promise.all(
    episodeKeys.map(key => loadExistingSegmentsForEpisode(key, apiKey))
  );

  // Return all segment types found
  const allSegments = [];
  for (let i = 0; i < episodeKeys.length; i++) {
    const key = episodeKeys[i];
    const set = results[i];
    for (const segType of set) {
      allSegments.push({ key, segmentType: segType });
    }
  }

  console.log('[NFE-DEDUP] loadExistingSegments: total existing segments found:', allSegments.length);
  return allSegments;
}

/**
 * Load existing segments for a specific episode (for export deduplication)
 * Uses GM_xmlhttpRequest to avoid CORS issues
 */
async function loadExistingSegmentsForEpisode(key, apiKey) {
  if (state.dedupCacheV2[key]) {
    return state.dedupCacheV2[key];
  }
  
  const [imdbId, season, episode] = key.split('|');
  const url = `${INTRODB_BASE}/segments?imdb_id=${encodeURIComponent(imdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`;
  
  const gmXhr = getGmXhr();
  
  return new Promise((resolve) => {
    if (gmXhr) {
      gmXhr({
        method: 'GET',
        url: url,
        headers: { 'Accept': 'application/json' },
        onload: (response) => {
          try {
            if (response.status === 200) {
              const json = JSON.parse(response.responseText);
              const set = new Set();
              for (const t of ['intro', 'recap', 'outro']) {
                if (json && json[t] != null) set.add(t);
              }
              state.dedupCacheV2[key] = set;
              resolve(set);
            } else {
              state.dedupCacheV2[key] = new Set();
              resolve(new Set());
            }
          } catch (_) {
            state.dedupCacheV2[key] = new Set();
            resolve(new Set());
          }
        },
        onerror: () => {
          state.dedupCacheV2[key] = new Set();
          resolve(new Set());
        }
      });
    } else {
      // Fallback to fetch (will likely fail due to CORS)
      fetch(url)
        .then(response => response.json())
        .then(json => {
          const set = new Set();
          for (const t of ['intro', 'recap', 'outro']) {
            if (json && json[t] != null) set.add(t);
          }
          state.dedupCacheV2[key] = set;
          resolve(set);
        })
        .catch(() => {
          state.dedupCacheV2[key] = new Set();
          resolve(new Set());
        });
    }
  });
}

/**
 * Submit a single segment to IntroDB
 * Uses GM_xmlhttpRequest to avoid CORS issues
 */
async function submitSegment(item, apiKey) {
  const url = `${INTRODB_BASE}/submit`;
  const gmXhr = getGmXhr();
  
  if (gmXhr) {
    return new Promise((resolve) => {
      gmXhr({
        method: 'POST',
        url: url,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        data: JSON.stringify({
          imdb_id: item.imdb_id,
          segment_type: item.segment_type,
          season: item.season,
          episode: item.episode,
          start_sec: item.start_sec,
          end_sec: item.end_sec,
        }),
        onload: (response) => {
          resolve({
            success: response.status >= 200 && response.status < 300,
            status: response.status
          });
        },
        onerror: () => {
          resolve({ success: false, status: 0 });
        }
      });
    });
  }
  
  // Fallback to fetch
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        imdb_id: item.imdb_id,
        segment_type: item.segment_type,
        season: item.season,
        episode: item.episode,
        start_sec: item.start_sec,
        end_sec: item.end_sec,
      }),
    });
    
    return {
      success: response.status >= 200 && response.status < 300,
      status: response.status
    };
  } catch (error) {
    return { success: false, status: 0 };
  }
}

  // ─── config/provider-config.js ───

/**
 * Provider configuration layer
 * Defines UI themes, branding, and service-specific settings
 */

/**
 * Base configuration for all providers
 */
const BASE_CONFIG = {
  INTRODB_BASE: 'https://api.introdb.app',
  IMDB_SUGGESTION_BASE: 'https://v3.sg.media-imdb.com',
};

/**
 * Provider-specific configurations
 * Each provider can customize colors, branding, and behavior
 */
const PROVIDER_CONFIGS = {
  netflix: {
    name: 'Netflix',
    match: 'https://www.netflix.com/*',
    colors: {
      primary: '#E50914',
      primaryDark: '#b30812',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
      background: 'rgba(12,12,12,0.98)',
      panelBg: '#181818',
      border: '#2c2c2c',
      text: '#fff',
      textSecondary: '#777',
      textMuted: '#444',
    },
    branding: {
      icon: '🎬',
      title: 'Timestamps Extractor',
    },
  },
  disneyplus: {
    name: 'Disney+',
    match: 'https://www.disneyplus.com/*',
    colors: {
      primary: '#0063e5',
      primaryDark: '#004bb3',
      secondary: '#0c734f',
      secondaryDark: '#095a3d',
      background: 'rgba(15, 23, 33, 0.98)',
      panelBg: '#1a2634',
      border: '#2a3a4a',
      text: '#fff',
      textSecondary: '#888',
      textMuted: '#555',
    },
    branding: {
      icon: '🏰',
      title: 'Timestamps Extractor',
    },
  },
  amazon: {
    name: 'Prime Video',
    match: 'https://www.amazon.com/*/detail/*',
    colors: {
      primary: '#ff9900',
      primaryDark: '#e68a00',
      secondary: '#0f79af',
      secondaryDark: '#0c5d86',
      background: 'rgba(18, 27, 36, 0.98)',
      panelBg: '#222f3d',
      border: '#334455',
      text: '#fff',
      textSecondary: '#999',
      textMuted: '#666',
    },
    branding: {
      icon: '📺',
      title: 'Timestamps Extractor',
    },
  },
  hbo: {
    name: 'HBO Max',
    match: 'https://play.max.com/*',
    colors: {
      primary: '#8a2be2',
      primaryDark: '#6a1b9e',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
      background: 'rgba(18, 18, 18, 0.98)',
      panelBg: '#222222',
      border: '#333333',
      text: '#fff',
      textSecondary: '#888',
      textMuted: '#555',
    },
    branding: {
      icon: '🎭',
      title: 'Timestamps Extractor',
    },
  },
};

/**
 * Get configuration for a specific provider
 * @param {string} providerName - The provider name
 * @returns {Object} - Provider configuration
 */
function getProviderConfig(providerName) {
  return PROVIDER_CONFIGS[providerName.toLowerCase()] || PROVIDER_CONFIGS.netflix;
}

/**
 * Get all provider names
 * @returns {string[]} - Array of provider names
 */
function getProviderNames() {
  return Object.keys(PROVIDER_CONFIGS);
}

  // ─── normalization/segment-mapper.js ───

/**
 * Segment type normalization layer
 * Maps provider-specific segment names to shared internal format
 */

/**
 * Standard internal segment types
 */
const SEGMENT_TYPES = {
  INTRO: 'intro',
  RECAP: 'recap',
  OUTRO: 'outro',
};

/**
 * Provider-specific segment name mappings
 * Each provider can have different names for the same segment types
 */
const PROVIDER_MAPPINGS = {
  netflix: {
    credit: SEGMENT_TYPES.INTRO,
    intro: SEGMENT_TYPES.INTRO,
    recap: SEGMENT_TYPES.RECAP,
    creditsOffset: SEGMENT_TYPES.OUTRO,
  },
  // Placeholder for other providers
  disneyplus: {
    intro: SEGMENT_TYPES.INTRO,
    recap: SEGMENT_TYPES.RECAP,
    outro: SEGMENT_TYPES.OUTRO,
    endCredits: SEGMENT_TYPES.OUTRO,
  },
  amazon: {
    openingCredits: SEGMENT_TYPES.INTRO,
    recap: SEGMENT_TYPES.RECAP,
    endCredits: SEGMENT_TYPES.OUTRO,
  },
  hbo: {
    intro: SEGMENT_TYPES.INTRO,
    recap: SEGMENT_TYPES.RECAP,
    outro: SEGMENT_TYPES.OUTRO,
  },
};

/**
 * Normalize a segment type from a provider to the internal format
 * @param {string} providerSegmentType - The segment type from the provider
 * @param {string} providerName - The provider name (e.g., 'netflix', 'disneyplus')
 * @returns {string|null} - The normalized segment type or null if not recognized
 */
function normalizeSegmentType(providerSegmentType, providerName) {
  const mappings = PROVIDER_MAPPINGS[providerName.toLowerCase()] || {};
  return mappings[providerSegmentType] || null;
}

/**
 * Create a normalized segment item
 * @param {Object} params - Segment parameters
 * @param {string} params.providerSegmentType - Provider-specific segment type
 * @param {string} params.providerName - Provider name
 * @param {string} params.episodeId - Episode identifier
 * @param {number} params.season - Season number
 * @param {number} params.episode - Episode number
 * @param {number} params.startSec - Start time in seconds
 * @param {number} params.endSec - End time in seconds
 * @param {string} [params.imdbId] - IMDb ID (optional, defaults to IMDB_PENDING)
 * @returns {Object|null} - Normalized segment item or null if type not recognized
 */
function createNormalizedSegment({
  providerSegmentType,
  providerName,
  episodeId,
  season,
  episode,
  startSec,
  endSec,
  imdbId = 'IMDB_PENDING'
}) {
  const segmentType = normalizeSegmentType(providerSegmentType, providerName);
  if (!segmentType) return null;
  
  return {
    _eid: episodeId,
    imdb_id: imdbId,
    segment_type: segmentType,
    season,
    episode,
    start_sec: startSec,
    end_sec: endSec,
  };
}

/**
 * Get all known segment types for a provider
 * @param {string} providerName - The provider name
 * @returns {string[]} - Array of normalized segment types
 */
function getProviderSegmentTypes(providerName) {
  const mappings = PROVIDER_MAPPINGS[providerName.toLowerCase()] || {};
  return [...new Set(Object.values(mappings))];
}

  // ─── ui/panel.js ───

/**
 * Shared UI panel component
 * Creates a reusable panel with provider-configurable styling
 */
// Default provider name
let currentProvider = 'netflix';

/**
 * Set the current provider name
 */
function setProviderName(name) {
  currentProvider = name;
}

/**
 * Create the UI panel with provider-specific styling
 * This function creates the panel and attaches all event handlers
 */
function createPanel() {
  console.log('[NFE] createPanel called, currentProvider:', currentProvider);
  const config = getProviderConfig(currentProvider);
  if (!config) {
    console.error('[NFE] No config found for provider:', currentProvider);
    return;
  }
  const { colors, branding } = config;
  
  if (document.getElementById('nfe-panel')) {
    console.log('[NFE] Panel already exists');
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'nfe-panel';
  panel.style.cssText = `
    position:fixed; z-index:2147483647; width:308px; max-width:calc(100vw - 40px);
    background:${colors.background}; border:1px solid ${colors.border}; border-radius:12px;
    padding:16px; color:${colors.text}; font-family:-apple-system,Arial,sans-serif;
    font-size:13px; box-shadow:0 16px 48px rgba(0,0,0,0.85);
    transition:opacity 0.18s; user-select:none; display:none; opacity:0;
  `;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700;color:${colors.primary}">${branding.icon} ${branding.title}</span>
      <button id="nfe-close" style="background:none;border:none;color:${colors.textMuted};font-size:18px;cursor:pointer;line-height:1;padding:0;transition:color 0.15s"
        onmouseenter="this.style.color='${colors.text}'" onmouseleave="this.style.color='${colors.textMuted}'">✕</button>
    </div>

    <div id="nfe-title-display" style="color:${colors.textSecondary};font-size:11px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:13px"></div>

    <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
      <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">IMDB ID</div>
      <div id="nfe-imdb-status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:7px;line-height:1.4">${state.dbStatusMsg}</div>
      <div style="display:flex;gap:4px">
        <input id="nfe-imdb-input" type="text" placeholder="ID (e.g. tt123456)..." value="${state.imdbId}"
          style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                 padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
          onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='#303030'"/>
        <button id="nfe-imdb-search" title="Search by title on IMDb"
          style="background:#242424;border:1px solid #303030;border-radius:6px;color:#bbb;
                 padding:6px 8px;cursor:pointer;font-size:12px;transition:background 0.15s"
          onmouseenter="this.style.background='#2e2e2e'" onmouseleave="this.style.background='#242424'">🔍</button>
        <button id="nfe-imdb-set"
          style="background:${colors.primary};border:none;border-radius:6px;color:#fff;
                 padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
          onmouseenter="this.style.background='${colors.primaryDark}'" onmouseleave="this.style.background='${colors.primary}'">OK</button>
      </div>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:8px">
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-ts"    style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Timestamps</div>
      </div>
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-req"   style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Responses</div>
      </div>
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-files" style="font-size:20px;font-weight:700;color:${colors.primary};line-height:1">0</div>
        <div style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Files</div>
      </div>
    </div>

    <div style="border-left:2px solid ${colors.primary};padding:6px 9px;margin-bottom:8px;font-size:11px;color:${colors.textMuted};line-height:1.4;background:${colors.panelBg};border-radius:0 7px 7px 0">
      Browse through seasons to capture all episodes.
    </div>

    <button id="nfe-export"
      style="width:100%;background:${colors.primary};border:none;border-radius:8px;color:#fff;
             padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
             transition:background 0.15s"
      onmouseenter="this.style.background='${colors.primaryDark}'" onmouseleave="this.style.background='${colors.primary}'">
      📥 Download JSON(s)
    </button>

     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">INTRODB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">API Key</div>
       <div style="display:flex;gap:4px">
         <input id="nfe-apikey-input" type="password" placeholder="Enter your IntroDB API key..." value="${state.introdbApiKey}"
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
           onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='#303030'"/>
         <button id="nfe-apikey-set"
           style="background:${colors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
           onmouseenter="this.style.background='${colors.primaryDark}'" onmouseleave="this.style.background='${colors.primary}'">Save</button>
       </div>
     </div>

     <div id="nfe-introdb-status" style="font-size:11px;color:${colors.textSecondary};min-height:13px;margin-bottom:6px;line-height:1.4;text-align:center"></div>

     <button id="nfe-submit"
       style="width:100%;background:${colors.secondary};border:none;border-radius:8px;color:#fff;
              padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
              transition:background 0.15s"
       onmouseenter="this.style.background='${colors.secondaryDark}'" onmouseleave="this.style.background='${colors.secondary}'">
       📡 Submit to IntroDB
     </button>

    <button id="nfe-clear"
      style="width:100%;background:transparent;border:1px solid #222;border-radius:8px;
             color:${colors.textMuted};padding:7px;cursor:pointer;font-size:12px;transition:all 0.15s"
      onmouseenter="this.style.borderColor='#444';this.style.color='#888'"
      onmouseleave="this.style.borderColor='#222';this.style.color='${colors.textMuted}'">
      🗑️ Clear data
    </button>
  `;

  document.body.appendChild(panel);
  console.log('[NFE] Panel created and appended to body');

  // Attach event listeners - use window.nfePanelCallbacks
  const setupEventListeners = () => {
    const closeBtn = document.getElementById('nfe-close');
    const exportBtn = document.getElementById('nfe-export');
    const submitBtn = document.getElementById('nfe-submit');
    const clearBtn = document.getElementById('nfe-clear');
    const imdbSetBtn = document.getElementById('nfe-imdb-set');
    const imdbSearchBtn = document.getElementById('nfe-imdb-search');
    const imdbInput = document.getElementById('nfe-imdb-input');
    const apikeySetBtn = document.getElementById('nfe-apikey-set');
    const apikeyInput = document.getElementById('nfe-apikey-input');
    
    if (closeBtn) closeBtn.addEventListener('click', () => {
      console.log('[NFE] Close button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onClose) {
        window.nfePanelCallbacks.onClose();
      }
    });
    if (exportBtn) exportBtn.addEventListener('click', () => {
      console.log('[NFE] Export button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onExport) {
        window.nfePanelCallbacks.onExport();
      }
    });
    if (submitBtn) submitBtn.addEventListener('click', () => {
      console.log('[NFE] Submit button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onSubmit) {
        window.nfePanelCallbacks.onSubmit();
      }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      console.log('[NFE] Clear button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onClear) {
        window.nfePanelCallbacks.onClear();
      }
    });
    if (imdbSetBtn) imdbSetBtn.addEventListener('click', () => {
      console.log('[NFE] IMDB set button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onImdbSet) {
        window.nfePanelCallbacks.onImdbSet();
      }
    });
    if (imdbSearchBtn) imdbSearchBtn.addEventListener('click', () => {
      console.log('[NFE] IMDB search button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onImdbSearch) {
        window.nfePanelCallbacks.onImdbSearch();
      }
    });
    if (imdbInput) imdbInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const imdbSetBtn = document.getElementById('nfe-imdb-set');
        if (imdbSetBtn) imdbSetBtn.click();
      }
    });
    if (apikeySetBtn) apikeySetBtn.addEventListener('click', () => {
      console.log('[NFE] API key set button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onApikeySet) {
        window.nfePanelCallbacks.onApikeySet();
      }
    });
    if (apikeyInput) apikeyInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const apikeySetBtn = document.getElementById('nfe-apikey-set');
        if (apikeySetBtn) apikeySetBtn.click();
      }
    });
  };
  
  setupEventListeners();

  panel.addEventListener('click', e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => e.stopPropagation());
}

/**
 * Keep the panel inside the lower-right viewport corner.
 */
function positionPanel(panel) {
  panel.style.right = '20px';
  panel.style.bottom = '20px';
  panel.style.left = 'auto';
  panel.style.transform = 'none';
}

/**
 * Toggle panel visibility
 */
function togglePanel() {
  console.log('[NFE] togglePanel called, panelVisible:', state.panelVisible);
  if (state.panelVisible) {
    closePanel();
  } else {
    openPanel();
  }
}

/**
 * Open the panel
 */
function openPanel() {
  console.log('[NFE] openPanel called');
  createPanel();
  const panel = document.getElementById('nfe-panel');
  if (!panel) {
    console.error('[NFE] Panel not found after createPanel');
    return;
  }
  console.log('[NFE] Panel found, positioning and showing');
  positionPanel(panel);
  state.panelVisible = true;
  panel.style.display = 'block';
  requestAnimationFrame(() => (panel.style.opacity = '1'));
  updateCounters();
  updatePanelTitle();
}

/**
 * Close the panel
 */
function closePanel() {
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  state.panelVisible = false;
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';
  setTimeout(() => {
    if (!state.panelVisible) {
      panel.style.display = 'none';
      panel.style.pointerEvents = 'auto';
    }
  }, 200);
}

/**
 * Update counter displays
 */
function updateCounters() {
  const $ = id => document.getElementById(id);
  const ts = $('nfe-cnt-ts');
  if (ts) ts.textContent = state.allItems.length;
  
  const rq = $('nfe-cnt-req');
  if (rq) rq.textContent = state.interceptedCount;
  
  const fl = $('nfe-cnt-files');
  if (fl) {
    const groups = new Map();
    for (const it of state.allItems) {
      const key = it.imdb_id || 'no_id';
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    let fileTotal = 0;
    for (const count of groups.values()) {
      fileTotal += Math.max(Math.ceil(count / 100), state.allItems.length ? 1 : 0);
    }
    fl.textContent = fileTotal;
  }
}

/**
 * Update the panel title with show information
 */
function updatePanelTitle() {
  const el = document.getElementById('nfe-title-display');
  if (!el) return;
  el.textContent = state.showTitle 
    ? `📺 ${state.showTitle}${state.showYear ? ` (${state.showYear})` : ''}` 
    : '';
}

/**
 * Update the IMDb input field with current imdbId
 */
function updateImdbInput() {
  const inp = document.getElementById('nfe-imdb-input');
  if (inp) inp.value = state.imdbId || '';
}

/**
 * Update the API key input field with current API key
 */
function updateApikeyInput() {
  const inp = document.getElementById('nfe-apikey-input');
  if (inp) inp.value = state.introdbApiKey || '';
}

/**
 * Show a toast notification
 */
function toast(msg) {
  console.log('[NFE]', msg);
  document.getElementById('nfe-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'nfe-toast';
  t.textContent = msg;
  t.style.cssText = `
    position:fixed; top:18px; left:50%; transform:translateX(-50%);
    background:rgba(12,12,12,0.96); color:#fff; border:1px solid #2a2a2a; border-radius:9px;
    padding:9px 18px; font-size:12px; font-family:-apple-system,Arial,sans-serif;
    z-index:2147483647; box-shadow:0 4px 20px rgba(0,0,0,0.7);
    pointer-events:none; transition:opacity 0.3s;
  `;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

/**
 * Show the export data in a modal before files are downloaded.
 * The preview deliberately uses textContent so captured metadata cannot inject HTML.
 */
function showExportPreview({ items, fileCount, duplicateCount, onConfirm }) {
  document.getElementById('nfe-export-preview')?.remove();

  const { colors } = getProviderConfig(currentProvider);
  const overlay = document.createElement('div');
  overlay.id = 'nfe-export-preview';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center;
    justify-content:center; padding:24px; background:rgba(0,0,0,.72);
  `;

  const dialog = document.createElement('section');
  dialog.style.cssText = `
    width:min(760px, 100%); max-height:calc(100vh - 48px); display:flex; flex-direction:column;
    padding:18px; border:1px solid ${colors.border}; border-radius:12px; background:${colors.background};
    color:${colors.text}; font:13px -apple-system,Arial,sans-serif; box-shadow:0 16px 48px rgba(0,0,0,.85);
  `;

  const heading = document.createElement('h2');
  heading.textContent = 'Controleer JSON-export';
  heading.style.cssText = `margin:0 0 6px; color:${colors.primary}; font-size:16px;`;
  const summary = document.createElement('p');
  summary.textContent = `${items.length} timestamps in ${fileCount} bestand(en)${duplicateCount ? `; ${duplicateCount} duplicaten uitgesloten` : ''}.`;
  summary.style.cssText = `margin:0 0 12px; color:${colors.textSecondary};`;
  const preview = document.createElement('pre');
  preview.textContent = JSON.stringify({ items }, null, 2);
  preview.style.cssText = `
    overflow:auto; flex:1; min-height:180px; margin:0 0 14px; padding:12px; border-radius:8px;
    background:${colors.panelBg}; color:${colors.text}; font:11px ui-monospace,Consolas,monospace; white-space:pre-wrap;
  `;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
  const cancel = document.createElement('button');
  cancel.textContent = 'Annuleren';
  cancel.style.cssText = 'padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; cursor:pointer;';
  const confirm = document.createElement('button');
  confirm.textContent = 'Download JSON';
  confirm.style.cssText = `padding:8px 12px; border:0; border-radius:6px; background:${colors.primary}; color:#fff; font-weight:700; cursor:pointer;`;

  const close = () => overlay.remove();
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  confirm.addEventListener('click', () => { close(); onConfirm(); });
  actions.append(cancel, confirm);
  dialog.append(heading, summary, preview, actions);
  overlay.append(dialog);
  document.body.append(overlay);
  confirm.focus();
}


  // ─── ui/button.js ───

/**
 * Shared button component
 * Injects a trigger button into the player UI
 */
/**
 * Get the "next episode" button element (provider-specific)
 * @param {string} providerName - The provider name
 * @returns {HTMLElement|null} - The next episode button element
 */
function getNextEpBtn(providerName) {
  // Default implementation - can be overridden by provider
  return (
    document.querySelector('[data-uia="control-next-episode"]') ||
    document.querySelector('button[aria-label*="iguiente" i]') ||
    document.querySelector('button[aria-label*="Next Episode" i]') ||
    document.querySelector('button[aria-label*="next-episode" i]')
  );
}

/**
 * Inject the trigger button into the page
 * @param {string} providerName - The provider name for theming
 * @param {Function} [getNextBtn] - Optional custom function to get next button
 */
function injectBtn(providerName, getNextBtn) {
  if (document.getElementById('nfe-btn')) {
    return;
  }
  
  const config = getProviderConfig(providerName);
  if (!config) {
    console.error('[NFE] No config found for provider:', providerName);
    return;
  }
  const { colors } = config;
  
  const nextBtn = getNextBtn ? getNextBtn() : getNextEpBtn(providerName);
  console.log('[NFE] nextBtn found:', !!nextBtn);

  const btn = document.createElement('button');
  btn.id = 'nfe-btn';
  btn.title = 'Timestamps Extractor';
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      xmlns="http://www.w3.org/2000/svg" style="display:block">
    <rect x="2" y="5" width="20" height="14" rx="1.5" stroke="white" stroke-width="1.6" fill="none"/>
    <line x1="6"  y1="5"  x2="6"  y2="19" stroke="white" stroke-width="1.6"/>
    <line x1="18" y1="5"  x2="18" y2="19" stroke="white" stroke-width="1.6"/>
    <line x1="2"  y1="9"  x2="6"  y2="9"  stroke="white" stroke-width="1.4"/>
    <line x1="18" y1="9"  x2="22" y2="9"  stroke="white" stroke-width="1.4"/>
    <line x1="2"  y1="15" x2="6"  y2="15" stroke="white" stroke-width="1.4"/>
    <line x1="18" y1="15" x2="22" y2="15" stroke="white" stroke-width="1.4"/>
    <polyline points="9,10 12,13.5 15,10" stroke="white" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <line x1="12" y1="8" x2="12" y2="13.5" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

  if (nextBtn) {
    btn.style.cssText = `
      background:none; border:none; cursor:pointer; padding:0; margin:0;
      width:40px; height:40px; display:inline-flex; align-items:center; justify-content:center;
      opacity:0.85; transition:opacity 0.15s, transform 0.15s; flex-shrink:0; vertical-align:middle;
      z-index:2147483000;
    `;
    btn.addEventListener('mouseenter', () => { 
      btn.style.opacity = '1';    
      btn.style.transform = 'scale(1.15)'; 
    });
    btn.addEventListener('mouseleave', () => { 
      btn.style.opacity = '0.85'; 
      btn.style.transform = 'scale(1)';    
    });
    nextBtn.insertAdjacentElement('beforebegin', btn);
    console.log('[NFE] Button inserted before nextBtn');
  } else {
    // Fallback: fixed floating button
    btn.style.cssText = `
      background:rgba(0,0,0,0.6); border:none; cursor:pointer; padding:6px; margin:0;
      width:36px; height:36px; display:inline-flex; align-items:center; justify-content:center;
      border-radius:6px; opacity:0.85; transition:opacity 0.15s; flex-shrink:0;
      position:fixed; bottom:90px; right:20px; z-index:2147483000;
    `;
    btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
    btn.addEventListener('mouseleave', () => (btn.style.opacity = '0.85'));
    document.body.appendChild(btn);
    console.log('[NFE] Button appended to body as fallback');
  }

  btn.addEventListener('click', e => { 
    console.log('[NFE] Button clicked, calling togglePanel');
    try {
      e.stopPropagation(); 
      e.preventDefault(); 
      if (typeof togglePanel === 'function') {
        togglePanel();
      } else {
        console.error('[NFE] togglePanel is not a function:', typeof togglePanel);
      }
    } catch (err) {
      console.error('[NFE] Error in button click handler:', err);
    }
  });
  console.log('[NFE] Button click handler attached');
}

  // ─── providers/netflix/extractor.js ───

/**
 * Netflix-specific segment extraction module
 * Handles detection, fetching, parsing, and normalization of Netflix segment data
 */
// Manual overrides for shows where IMDb's title-suggestion search returns
// the wrong entry. Keyed by Netflix's stable series-level video.id.
const NETFLIX_TITLE_OVERRIDES = {
  '81748089': 'tt2431250', // Het kleine huis op de prairie -> correct IMDb entry
};

/**
 * Process Netflix metadata and extract segments
 * @param {Object} data - The metadata response from Netflix API
 * @param {string} providerName - The provider name
 */
function processMetadata(data, providerName) {
  const video = data.video;
  if (!video) return;

if (video.title && state.showTitle !== video.title) {
    state.showTitle = video.title;
    state.showId = video.id != null ? String(video.id) : null;
    state.showYear = '';
    if (video.seasons && video.seasons[0]) {
      state.showYear = String(video.seasons[0].year || '');
    }
    state.dbSearchDone = false;
    state.imdbId = '';
    state.dedupCacheV2 = {};
    updatePanelTitle();
    console.log(`[NFE] Show ID (stable, series-level): ${state.showId}`);
  }

  if (!state.dbSearchDone && state.showTitle) {
    state.dbSearchDone = true;
    const override = state.showId && NETFLIX_TITLE_OVERRIDES[state.showId];
    console.log('[NFE] IMDb lookup triggered for showTitle:', state.showTitle, 'showYear:', state.showYear, 'override:', override);
    if (override) {
      state.imdbId = override;
      state.allItems.forEach(i => { 
        if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = override; 
      });
      updateImdbInput();
      setDbStatus(`Manual override applied · ID: ${override}`);
      updateCounters();
      loadExistingSegments(override);
     } else {
       searchImdbByTitle(state.showTitle, state.showYear).then(result => {
         console.log('[NFE] IMDb search result:', result);
         if (result.success) {
           state.imdbId = result.imdbId;
           state.allItems.forEach(i => { 
             if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = result.imdbId; 
           });
           updateImdbInput();
           setDbStatus(`Found: ${result.imdbId}`);
           updateCounters();
           loadExistingSegments(result.imdbId);
         } else {
           setDbStatus(`IMDb lookup failed: ${result.error}`);
         }
       }).catch(err => {
         console.error('[NFE] IMDb search error:', err);
         setDbStatus('IMDb lookup error');
       });
     }
   }

  let newItems = 0;
  for (const season of (video.seasons || [])) {
    const sNum = season.seq;
    for (const ep of (season.episodes || [])) {
      const eid = ep.episodeId || ep.id;
      if (state.allItems.some(i => i._eid === eid)) continue;

      const eNum = ep.seq;
      const tid = state.imdbId || 'IMDB_PENDING';
      const mk = ep.skipMarkers || {};

      // Extract segments using normalization layer
      const recap = mk.recap;
      if (recap && recap.end > 0) {
        const item = createNormalizedSegment({
          providerSegmentType: 'recap',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: recap.start / 1000,
          endSec: recap.end / 1000,
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }

      const credit = mk.credit;
      if (credit && credit.end > 0) {
        const item = createNormalizedSegment({
          providerSegmentType: 'credit',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: credit.start / 1000,
          endSec: credit.end / 1000,
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }

      const intro = mk.intro;
      if (intro && intro.end > 0) {
        const item = createNormalizedSegment({
          providerSegmentType: 'intro',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: intro.start / 1000,
          endSec: intro.end / 1000,
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }

      // Outro from creditsOffset and runtime
      if (ep.creditsOffset && ep.runtime) {
        const item = createNormalizedSegment({
          providerSegmentType: 'creditsOffset',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: parseFloat(ep.creditsOffset),
          endSec: parseFloat(ep.runtime),
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }
    }
  }

  if (newItems > 0) {
    state.interceptedCount++;
    updateCounters();
    toast(`+${newItems} timestamps captured · total: ${state.allItems.length}`);
  }
}

/**
 * Set the IMDb status message
 */
function setDbStatus(msg) {
  state.dbStatusMsg = msg;
  const el = document.getElementById('nfe-imdb-status');
  if (el) el.textContent = msg;
}

/**
 * Set the IntroDB status message
 */
function setIntrodbStatus(msg) {
  const el = document.getElementById('nfe-introdb-status');
  if (el) el.textContent = msg;
}

/**
 * Export captured timestamps to JSON files
 */
async function exportJSON() {
  if (!state.allItems.length) { 
    toast('No timestamps yet.'); 
    return; 
  }

  // Group by each item's OWN imdb_id
  let items = state.allItems.map(({ _eid, ...rest }) => rest);
  const pendingCount = items.filter(i => i.imdb_id === 'IMDB_PENDING').length;
  if (pendingCount > 0) {
    const proceed = confirm(`${pendingCount} timestamp(s) still have no IMDb ID assigned (IMDB_PENDING).\nThese will be exported as-is. Continue?`);
    if (!proceed) return;
  }

  // Local dedup against IntroDB
  const episodeKeys = [...new Set(
    items
      .filter(i => i.imdb_id && i.imdb_id !== 'IMDB_PENDING')
      .map(i => `${i.imdb_id}|${i.season}|${i.episode}`)
  )];
  
  const notLoaded = episodeKeys.filter(k => !(state.dedupCacheV2 && state.dedupCacheV2[k]));
  if (notLoaded.length > 0) {
    toast(`Checking IntroDB for existing segments (${notLoaded.length} episode(s))...`);
    await Promise.all(notLoaded.map(k => loadExistingSegmentsForEpisode(k)));
  }

  const beforeCount = items.length;
  items = items.filter(item => !isAlreadyInIntroDB(item));
  
  const dupCount = beforeCount - items.length;
  if (dupCount > 0) toast(`${dupCount} duplicate(s) already in IntroDB removed from export.`);

  if (!items.length) { 
    toast('Nothing left to export after removing duplicates.'); 
    return; 
  }

  // Group by IMDb ID for file output
  const groups = new Map();
  for (const item of items) {
    const key = item.imdb_id || 'no_id';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  // Build files and download with delay
  const files = [];
  const N = 100;
  for (const [tid, groupItems] of groups) {
    const total = Math.ceil(groupItems.length / N);
    for (let i = 0; i < total; i++) {
      files.push({
        tid,
        part: total > 1 ? `_part${i + 1}of${total}` : '',
        data: groupItems.slice(i * N, (i + 1) * N),
      });
    }
  }

  let downloaded = 0;
  function downloadNext(idx) {
    if (idx >= files.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${items.length} entries`);
      return;
    }
    const f = files[idx];
    const blob = new Blob([JSON.stringify({ items: f.data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `timestamps_${f.tid}${f.part}.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    downloaded++;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTimeout(() => downloadNext(idx + 1), 400);
  }
  showExportPreview({
    items,
    fileCount: files.length,
    duplicateCount: dupCount,
    onConfirm: () => downloadNext(0),
  });
}

/**
 * Submit all timestamps to IntroDB
 */
async function submitToIntroDB() {
  if (!state.allItems.length) { 
    toast('No timestamps to submit.'); 
    return; 
  }

  const apiKey = state.introdbApiKey;
  if (!apiKey) {
    toast('Please enter your IntroDB API key in the panel above.');
    setIntrodbStatus('No API key configured');
    return;
  }

  if (state.submitInProgress) { 
    toast('Submission in progress, please wait...'); 
    return; 
  }

  // Each item keeps its OWN imdb_id
  const allMapped = state.allItems.map(({ _eid, ...rest }) => rest);
  const pendingItems = allMapped.filter(i => i.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length > 0) {
    toast(`${pendingItems.length} timestamp(s) have no IMDb ID yet (IMDB_PENDING) and will be skipped.`);
  }

  // Pre-load cache for all episodes before filtering
  const episodeKeys = [...new Set(
    allMapped
      .filter(i => i.imdb_id && i.imdb_id !== 'IMDB_PENDING')
      .map(i => createEpisodeCacheKey(i.imdb_id, i.season, i.episode))
  )];
  
  const notLoaded = episodeKeys.filter(k => !(state.dedupCacheV2 && state.dedupCacheV2[k]));
  if (notLoaded.length > 0) {
    toast(`Checking IntroDB for existing segments (${notLoaded.length} episode(s))...`);
    await Promise.all(notLoaded.map(k => loadExistingSegmentsForEpisode(k)));
  }

  const items = allMapped.filter(item => item.imdb_id !== 'IMDB_PENDING' && !isAlreadyInIntroDB(item));
  const skipped = allMapped.length - items.length;

  if (!items.length) {
    toast('All timestamps already exist in IntroDB.');
    setIntrodbStatus('Nothing new to submit (all duplicates)');
    return;
  }

  const skipMsg = skipped > 0 ? ` (${skipped} already existed, skipped)` : '';
  const idList = [...new Set(items.map(i => i.imdb_id))].join(', ');
  if (!confirm(`Submit ${items.length} timestamp${items.length !== 1 ? 's' : ''} to IntroDB?${skipMsg}\nID(s): ${idList}`)) return;

  state.submitInProgress = true;
  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn('Submitting 0/' + items.length + '...');

  let sent = 0;

  function sendNext(idx) {
    if (idx >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('📡 Submit to IntroDB');
      toast(`IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      setIntrodbStatus(`${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      return;
    }

    const item = items[idx];
    submitSegment(item, apiKey).then(result => {
      sent++;
      if (result.success) {
        state.submitResults.ok++;
        // Update cache for consistency (using shared helper)
        const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
        if (!state.dedupCacheV2[key]) {
          state.dedupCacheV2[key] = new Set();
        }
        state.dedupCacheV2[key].add(item.segment_type);
      } else {
        state.submitResults.fail++;
        console.warn('[NFE] IntroDB rejected:', result.status, item);
      }
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(idx + 1), 150);
    }).catch(() => {
      sent++;
      state.submitResults.fail++;
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(idx + 1), 150);
    });
  }

  sendNext(0);
}

/**
 * Check the per-episode cache for an existing segment.
 * A missing cache entry is treated as not found; callers load the cache first.
 */
function isAlreadyInIntroDB(item) {
  const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
  return state.dedupCacheV2[key]?.has(item.segment_type) ?? false;
}

/**
 * Update the submit button label
 */
function updateSubmitBtn(label) {
  const btn = document.getElementById('nfe-submit');
  if (btn) btn.textContent = label;
}

/**
 * Clear all captured data
 */
function clearData() {
  if (!confirm('Delete all captured timestamps?')) return;
  Object.assign(state, {
    allItems: [],
    imdbId: '',
    interceptedCount: 0,
    dbSearchDone: false,
    dbStatusMsg: 'Waiting for Netflix metadata...',
    showTitle: '',
    showYear: '',
    submitResults: { ok: 0, fail: 0 },
    dedupCacheV2: {},
  });
  updateCounters();
  updatePanelTitle();
  setDbStatus('Waiting for Netflix metadata...');
  setIntrodbStatus('');
  updateImdbInput();
  toast('Data cleared');
}


  // ─── providers/netflix/index.js ───

/**
 * Netflix provider entry point
 * Sets up network interception and initializes the Netflix-specific extraction
 */
const PROVIDER_NAME = 'netflix';
const config = getProviderConfig(PROVIDER_NAME);

// Initialize state with provider name
Object.assign(state, createState(config.name));

// Set up panel callbacks and provider name on window object
setProviderName(PROVIDER_NAME);
window.nfePanelCallbacks = {
  onClose: closePanel,
  onExport: exportJSON,
  onSubmit: submitToIntroDB,
  onClear: clearData,
onImdbSet: () => {
    const v = document.getElementById('nfe-imdb-input').value.trim();
    if (!v) return;
    state.imdbId = v;
    state.allItems.forEach(i => { if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = v; });
    state.dedupCacheV2 = {};
    setDbStatus(`ID saved: ${v}`);
    updateCounters();
  },
onImdbSearch: () => {
      const manual = document.getElementById('nfe-imdb-input').value.trim();
      const q = manual || state.showTitle;
      if (!q) { toast('No title detected yet.'); return; }
      state.dbSearchDone = false;
      state.dedupCacheV2 = {};
      searchImdbByTitle(q, state.showYear).then(result => {
        console.log('[NFE] Manual IMDb search result:', result);
        if (result.success) {
          state.imdbId = result.imdbId;
          state.allItems.forEach(i => { 
            if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = result.imdbId; 
          });
          updateImdbInput();
          setDbStatus(`Found: ${result.imdbId}`);
          updateCounters();
          loadExistingSegments(result.imdbId);
        } else {
          setDbStatus(`IMDb lookup failed: ${result.error}`);
        }
      }).catch(err => {
        console.error('[NFE] Manual IMDb search error:', err);
        setDbStatus('IMDb lookup error');
      });
    },
  onApikeySet: () => {
    const v = document.getElementById('nfe-apikey-input').value.trim();
    if (!v) {
      toast('Please enter an IntroDB API key.');
      return;
    }
    state.introdbApiKey = v;
    setIntrodbStatus('API key saved');
    toast('IntroDB API key saved');
  },
};

/**
 * Set up XHR and fetch interception for Netflix metadata
 */
function setupInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const OriginalXHR = win.XMLHttpRequest;
  function InterceptedXHR() {
    const xhr = new OriginalXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) { 
      _url = url; 
      return origOpen(method, url, ...rest); 
    };
    const origSend = xhr.send.bind(xhr);
    xhr.send = function (...args) {
      if (_url && _url.includes('memberapi') && _url.includes('metadata')) {
        xhr.addEventListener('load', () => {
          try { 
            const d = JSON.parse(xhr.responseText); 
            if (d && d.video) processMetadata(d, PROVIDER_NAME); 
          } catch (_) {}
        });
      }
      return origSend(...args);
    };
    return xhr;
  }
  Object.setPrototypeOf(InterceptedXHR, OriginalXHR);
  InterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = InterceptedXHR;

  const origFetch = win.fetch.bind(win);
  win.fetch = async function (input, init) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const resp = await origFetch(input, init);
    if (url.includes('memberapi') && url.includes('metadata')) {
      try { 
        const d = await resp.clone().json(); 
        if (d && d.video) processMetadata(d, PROVIDER_NAME); 
      } catch (_) {}
    }
    return resp;
  };
}

/**
 * Set up panel click-outside handler
 */
function setupPanelHandler() {
  document.addEventListener('click', e => {
    const panel = document.getElementById('nfe-panel');
    const btn = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(e.target) && !btn?.contains(e.target)) {
      closePanel();
    }
  }, true);
}

/**
 * Sync panel visibility with player controls
 */
function syncVisibility() {
  if (!state.panelVisible) return;
  const ctrl =
    document.querySelector('[data-uia="controls-standard"]') ||
    document.querySelector('[class*="PlayerControls"]') ||
    document.querySelector('.watch-video--bottom-controls-container');
  if (!ctrl) return;
  const visible = parseFloat(getComputedStyle(ctrl).opacity) > 0.05;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  panel.style.opacity = visible ? '1' : '0';
  panel.style.pointerEvents = visible ? 'auto' : 'none';
}

/**
 * Main loop - inject button and sync on watch pages
 */
function mainLoop() {
  let lastPath = location.pathname;
  setInterval(() => {
    const inWatch = location.pathname.startsWith('/watch');
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      document.getElementById('nfe-btn')?.remove();
      if (!inWatch) { 
        document.getElementById('nfe-panel')?.remove(); 
        state.panelVisible = false; 
      }
    }
    if (inWatch) { 
      injectBtn(PROVIDER_NAME, getNextEpBtn); 
      syncVisibility(); 
    }
  }, 1000);
}

// Initialize
setupInterception();
setupPanelHandler();
mainLoop();

// Debug helpers - exposed to unsafeWindow for console access
const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
win.__netflixTimestamps = {
  getAll: () => state.allItems,
  getShowId: () => state.showId,
  state,
};

})();
