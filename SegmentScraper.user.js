// ==UserScript==
// @name         SegmentScraper v1.5.6 - Multi-Provider Timestamps Extractor
// @version      1.5.6
// @namespace    https://github.com/mronion212/SegmentScraper
// @description  Extracts intro/recap/outro timestamps from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.
// @author       mronion212
// @match        https://www.netflix.com/*
// @match        https://www.disneyplus.com/*
// @match        https://www.primevideo.com/*
// @match        https://www.amazon.*/gp/video/*
// @match        https://*.primevideo.com/*
// @match        https://tv.apple.com/*
// @match        https://www.videoland.com/*
// @match        https://videoland.com/*
// @match        https://v2.videoland.com/*
// @match        https://*.videoland.com/*
// @match        https://play.max.com/*
// @match        https://www.skyshowtime.com/*
// @match        https://skyshowtime.com/*
// @match        https://www.crunchyroll.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      v3.sg.media-imdb.com
// @connect      api.introdb.app
// @connect      api4.thetvdb.com
// @connect      atom.skyshowtime.com
// @connect      static.crunchyroll.com
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
  showIds: new Set(),
  imdbIdsByShowId: {},
  interceptedCount: 0,
  panelVisible: false,
  submitInProgress: false,
  submitResults: { ok: 0, fail: 0 },
  dedupCacheV2: {},
  introdbApiKey: '',
  tvdbApiKey: '',
  tvdbPin: '',
  providerEpisodes: [],
  providerEpisodesByShowId: {},
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
async function loadExistingSegmentsForEpisode(key, apiKey, { useCache = true, writeCache = true } = {}) {
  if (useCache && state.dedupCacheV2[key]) {
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
              if (writeCache) state.dedupCacheV2[key] = set;
              resolve(set);
            } else {
              if (writeCache) state.dedupCacheV2[key] = new Set();
              resolve(new Set());
            }
          } catch (_) {
            if (writeCache) state.dedupCacheV2[key] = new Set();
            resolve(new Set());
          }
        },
        onerror: () => {
          if (writeCache) state.dedupCacheV2[key] = new Set();
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
          if (writeCache) state.dedupCacheV2[key] = set;
          resolve(set);
        })
        .catch(() => {
          if (writeCache) state.dedupCacheV2[key] = new Set();
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

/**
 * Look up the display title for a known IMDb title ID.
 */
async function lookupImdbTitle(imdbId) {
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(imdbId)}.json`;
  const gmXhr = getGmXhr();

  try {
    const responseText = gmXhr
      ? await new Promise((resolve, reject) => {
          gmXhr({
            method: 'GET',
            url,
            timeout: 10000,
            headers: { Accept: 'application/json' },
            onload: response => resolve(response.responseText),
            onerror: reject,
            ontimeout: reject,
          });
        })
      : await fetch(url).then(response => response.text());
    const result = (JSON.parse(responseText).d || []).find(item => item.id === imdbId);
    return result ? { success: true, title: result.l, year: result.y } : { success: false };
  } catch (_) {
    return { success: false };
  }
}


  // ─── core/introdb-settings.js ───

/** Local IntroDB credential storage. The key is never returned to UI code. */

const INTRODB_API_KEY_STORAGE = 'segmentScraper.introdb.apikey';

function getStoredIntrodbValue(key, fallback = '') {
  try {
    return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setStoredIntrodbValue(key, value) {
  try {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  } catch (_) {}
}

function loadIntrodbSettings() {
  state.introdbApiKey = String(getStoredIntrodbValue(INTRODB_API_KEY_STORAGE, '') || '');
  return { configured: Boolean(state.introdbApiKey) };
}

function saveIntrodbSettings(apiKey) {
  const nextApiKey = String(apiKey || '').trim();
  state.introdbApiKey = nextApiKey;
  setStoredIntrodbValue(INTRODB_API_KEY_STORAGE, nextApiKey);
  return { configured: Boolean(nextApiKey) };
}


  // ─── core/tvdb.js ───

/** TVDB v4 authentication, local settings, and conservative episode mapping. */
const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const TVDB_STORAGE = {
  apiKey: 'segmentScraper.tvdb.apikey',
  pin: 'segmentScraper.tvdb.pin',
  token: 'segmentScraper.tvdb.token',
  tokenCreatedAt: 'segmentScraper.tvdb.tokenCreatedAt',
};
const TOKEN_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
const TVDB_EPISODE_LANGUAGE = 'eng';
const TVDB_SEASON_TYPE = 'default';
const TVDB_EPISODE_ENDPOINT_SHAPE = `${TVDB_BASE}/series/{seriesId}/episodes/{seasonType}/{language}?page={page}`;
let loginPromise = null;
const episodeListCache = new Map();
const episodeTranslationCache = new Map();

function getStoredValue(key, fallback = '') {
  try {
    return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setStoredValue(key, value) {
  try {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  } catch (_) {}
}

function getGmXhr() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) ||
    (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
    (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

function tvdbRequest({ method = 'GET', path, token = '', data }) {
  const url = `${TVDB_BASE}${path}`;
  const headers = { Accept: 'application/json' };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const gmXhr = getGmXhr();

  if (gmXhr) {
    return new Promise((resolve, reject) => {
      gmXhr({
        method,
        url,
        headers,
        data: data === undefined ? undefined : JSON.stringify(data),
        timeout: 15000,
        onload: response => {
          let body = null;
          try { body = response.responseText ? JSON.parse(response.responseText) : null; } catch (_) {}
          resolve({ status: response.status, body });
        },
        onerror: () => reject(new Error('TVDB network request failed')),
        ontimeout: () => reject(new Error('TVDB network request timed out')),
      });
    });
  }

  return fetch(url, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  }).then(async response => {
    let body = null;
    try { body = await response.json(); } catch (_) {}
    return { status: response.status, body };
  });
}

function loadTvdbSettings() {
  state.tvdbApiKey = String(getStoredValue(TVDB_STORAGE.apiKey, '') || '');
  state.tvdbPin = String(getStoredValue(TVDB_STORAGE.pin, '') || '');
  return { apiKey: state.tvdbApiKey, pin: state.tvdbPin };
}

function saveTvdbSettings(apiKey, pin = '') {
  const nextApiKey = String(apiKey || '').trim();
  const nextPin = String(pin || '').trim();
  const credentialsChanged = nextApiKey !== state.tvdbApiKey || nextPin !== state.tvdbPin;
  state.tvdbApiKey = nextApiKey;
  state.tvdbPin = nextPin;
  setStoredValue(TVDB_STORAGE.apiKey, nextApiKey);
  setStoredValue(TVDB_STORAGE.pin, nextPin);
  if (credentialsChanged) clearTvdbToken();
}

function clearTvdbToken() {
  setStoredValue(TVDB_STORAGE.token, '');
  setStoredValue(TVDB_STORAGE.tokenCreatedAt, 0);
}

async function loginTvdb() {
  if (!state.tvdbApiKey) throw new Error('No TVDB API key configured');
  const credentials = { apikey: state.tvdbApiKey };
  if (state.tvdbPin) credentials.pin = state.tvdbPin;
  const response = await tvdbRequest({ method: 'POST', path: '/login', data: credentials });
  const token = response.body?.data?.token;
  if (response.status < 200 || response.status >= 300 || !token) {
    throw new Error(`TVDB login failed (HTTP ${response.status || 0})`);
  }
  setStoredValue(TVDB_STORAGE.token, token);
  setStoredValue(TVDB_STORAGE.tokenCreatedAt, Date.now());
  return token;
}

async function getTvdbToken(forceRefresh = false) {
  const token = String(getStoredValue(TVDB_STORAGE.token, '') || '');
  const createdAt = Number(getStoredValue(TVDB_STORAGE.tokenCreatedAt, 0)) || 0;
  if (!forceRefresh && token && createdAt && Date.now() - createdAt < TOKEN_MAX_AGE_MS) return token;
  if (!loginPromise) loginPromise = loginTvdb().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function authenticatedTvdbGet(path) {
  let token = await getTvdbToken(false);
  let response = await tvdbRequest({ path, token });
  if (response.status === 401) {
    clearTvdbToken();
    token = await getTvdbToken(true);
    response = await tvdbRequest({ path, token });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`TVDB request failed (HTTP ${response.status || 0})`);
  }
  return response.body?.data;
}

function cachedTvdbGet(cache, key, path) {
  if (!cache.has(key)) {
    const request = authenticatedTvdbGet(path).catch(error => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, request);
  }
  return cache.get(key);
}

async function fetchTvdbEpisodeList(seriesId, language = TVDB_EPISODE_LANGUAGE) {
  const normalizedLanguage = String(language || TVDB_EPISODE_LANGUAGE).trim().toLowerCase();
  const encodedSeriesId = encodeURIComponent(seriesId);
  const encodedLanguage = encodeURIComponent(normalizedLanguage);
  const cacheKey = `series:${seriesId}|seasonType:${TVDB_SEASON_TYPE}|language:${normalizedLanguage}|page:0`;
  const path = `/series/${encodedSeriesId}/episodes/${TVDB_SEASON_TYPE}/${encodedLanguage}?page=0`;
  const data = await cachedTvdbGet(episodeListCache, cacheKey, path);
  return data?.series?.episodes || data?.episodes || [];
}

async function fetchTvdbEpisodeTranslation(episodeId, language = TVDB_EPISODE_LANGUAGE) {
  const normalizedLanguage = String(language || TVDB_EPISODE_LANGUAGE).trim().toLowerCase();
  const cacheKey = `episode:${episodeId}|language:${normalizedLanguage}`;
  const path = `/episodes/${encodeURIComponent(episodeId)}/translations/${encodeURIComponent(normalizedLanguage)}`;
  return cachedTvdbGet(episodeTranslationCache, cacheKey, path);
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isGenericEpisodeTitle(value) {
  const title = normalizeTitle(value);
  return /^(?:episode|aflevering|folge|episodio|episode|capitulo|chapter|part|deel)\s*(?:(?:no|number|nr)\s*)?\d+$/.test(title) ||
    /^(?:s\s*\d+\s*)?e\s*\d+$/.test(title);
}

function incrementReason(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function describeSkipReasons(reasons) {
  const labels = {
    genericTitle: 'generic titles',
    missingTitle: 'missing titles',
    duplicateProviderTitle: 'duplicate provider titles',
    noExactMatch: 'no exact normalized TVDB match',
    ambiguousTvdbTitle: 'ambiguous TVDB titles',
    reusedTvdbEpisode: 'TVDB episode already matched',
  };
  return Object.entries(reasons)
    .map(([reason, count]) => `${labels[reason] || reason}: ${count}`)
    .join(', ');
}

function normalizeProviderEpisodes(episodes) {
  const unique = new Map();
  for (const episode of episodes || []) {
    const season = Number(episode.season);
    const number = Number(episode.episode);
    if (!Number.isInteger(season) || !Number.isInteger(number) || season < 0 || number < 1) continue;
    const key = episode.providerId ? `id:${episode.providerId}` : `number:${season}:${number}`;
    const normalized = {
      providerId: episode.providerId == null ? '' : String(episode.providerId),
      season,
      episode: number,
      title: String(episode.title || '').trim(),
      isSpecial: season === 0 || episode.isSpecial === true,
    };
    if (!unique.has(key)) unique.set(key, normalized);
    else if (!unique.get(key).title && normalized.title) unique.get(key).title = normalized.title;
  }
  return [...unique.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function getDeclaredEpisodeNameLanguage(episode) {
  return String(episode?.nameLanguage || episode?.language || '').trim().toLowerCase();
}

function summarizeEpisodeNameLanguages(episodes) {
  const counts = {};
  for (const episode of episodes) {
    const language = episode._nameLanguage || 'unknown';
    counts[language] = (counts[language] || 0) + 1;
  }
  return counts;
}

async function ensureTvdbEpisodeNameLanguage(episodes, providerEpisodes, language) {
  const providerTitlesByNumber = new Map(providerEpisodes
    .map(episode => [`${episode.season}|${episode.episode}`, normalizeTitle(episode.title)])
    .filter(([, title]) => title));
  return Promise.all((episodes || []).map(async episode => {
    const returnedTitle = normalizeTitle(episode?.name);
    const declaredLanguage = getDeclaredEpisodeNameLanguage(episode);
    const correspondingProviderTitle = providerTitlesByNumber.get(`${episode?.seasonNumber}|${episode?.number}`);
    const contradictsProviderTitle = correspondingProviderTitle && returnedTitle !== correspondingProviderTitle;
    const returnedLanguage = declaredLanguage || language;
    const needsExplicitTranslation = episode?.id != null && (
      !returnedTitle ||
      (declaredLanguage && declaredLanguage !== language) ||
      contradictsProviderTitle
    );

    if (!needsExplicitTranslation) return { ...episode, _nameLanguage: returnedLanguage };

    try {
      const translation = await fetchTvdbEpisodeTranslation(episode.id, language);
      const translatedName = String(translation?.name || '').trim();
      if (translatedName) {
        return {
          ...episode,
          name: translatedName,
          _nameLanguage: String(translation?.language || language).trim().toLowerCase(),
        };
      }
    } catch (error) {
      console.warn('[TVDB] Explicit episode translation request failed', {
        episodeId: episode.id,
        requestedLanguage: language,
        endpointUrlShape: `${TVDB_BASE}/episodes/{episodeId}/translations/{language}`,
        reason: error?.message || String(error),
      });
    }
    return { ...episode, _nameLanguage: returnedLanguage };
  }));
}

function logTvdbEpisodeLanguageAudit(seriesId, language, receivedEpisodes, matchingEpisodes) {
  const matchingById = new Map((matchingEpisodes || []).map(episode => [String(episode.id), episode]));
  const titleResponse = {
    seriesId: String(seriesId),
    requestedLanguage: language,
    episodes: (receivedEpisodes || []).map(episode => {
      const matching = matchingById.get(String(episode.id)) || episode;
      return {
        id: episode.id,
        season: episode.seasonNumber,
        episode: episode.number,
        receivedTitle: String(episode.name || '').trim(),
        receivedLanguage: getDeclaredEpisodeNameLanguage(episode) || 'unknown',
        matchingTitle: String(matching.name || '').trim(),
        matchingLanguage: String(matching._nameLanguage || getDeclaredEpisodeNameLanguage(matching) || language).trim().toLowerCase(),
      };
    }),
  };
  console.info('[TVDB] Series episode language audit', {
    seriesId: String(seriesId),
    requestedLanguage: language,
    endpointUrlShape: TVDB_EPISODE_ENDPOINT_SHAPE,
    returnedEpisodeNameLanguages: summarizeEpisodeNameLanguages(matchingEpisodes),
  });
  console.info('[TVDB] Series episode title response', titleResponse);
  console.info('[TVDB] Series episode title response JSON', JSON.stringify(titleResponse));
}

function logTvdbEpisodeMatchTitles(seriesId, providerEpisodes, episodes) {
  const matchingInput = {
    seriesId: String(seriesId),
    providerEpisodes: providerEpisodes.map(episode => ({
      providerId: episode.providerId,
      season: episode.season,
      episode: episode.episode,
      title: episode.title,
    })),
    tvdbEpisodes: episodes.map(episode => ({
      id: episode.id,
      season: episode.season,
      episode: episode.episode,
      titles: [episode.title, ...(episode.alternateTitles || [])].filter(Boolean),
    })),
  };
  console.info('[TVDB] Episode titles available for matching', matchingInput);
  console.info('[TVDB] Title matching input JSON', JSON.stringify(matchingInput));
}

function cleanTvdbEpisodes(episodes) {
  const unique = new Map();
  let specialsExcluded = 0;
  for (const episode of episodes || []) {
    const season = Number(episode.seasonNumber);
    const number = Number(episode.number);
    if (season === 0) {
      specialsExcluded++;
      continue;
    }
    if (!Number.isInteger(season) || !Number.isInteger(number) || season < 1 || number < 1 || episode.id == null) continue;
    if (!unique.has(String(episode.id))) unique.set(String(episode.id), {
      id: episode.id,
      season,
      episode: number,
      title: String(episode.name || '').trim(),
    });
  }
  return {
    episodes: [...unique.values()].sort((a, b) => a.season - b.season || a.episode - b.episode),
    specialsExcluded,
  };
}

function mergeTvdbEpisodeTitles(primaryCatalog, alternateCatalogs) {
  const byId = new Map(primaryCatalog.episodes.map(episode => [String(episode.id), episode]));
  const byNumber = new Map(primaryCatalog.episodes.map(episode => [`${episode.season}|${episode.episode}`, episode]));
  for (const catalog of alternateCatalogs) {
    for (const alternate of catalog.episodes) {
      const target = byId.get(String(alternate.id)) || byNumber.get(`${alternate.season}|${alternate.episode}`);
      const title = String(alternate.title || '').trim();
      if (!target || !title || normalizeTitle(title) === normalizeTitle(target.title)) continue;
      target.alternateTitles ||= [];
      if (!target.alternateTitles.some(existing => normalizeTitle(existing) === normalizeTitle(title))) {
        target.alternateTitles.push(title);
      }
    }
  }
  return primaryCatalog;
}

function findDuplicateNumber(episodes) {
  const seen = new Set();
  for (const episode of episodes) {
    const key = `${episode.season}|${episode.episode}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

function mapEpisodes(providerEpisodes, tvdbEpisodes, { requireTitleMatch = false } = {}) {
  const mapping = new Map();
  if (!requireTitleMatch && providerEpisodes.length === tvdbEpisodes.length) {
    providerEpisodes.forEach((episode, index) => mapping.set(`${episode.season}|${episode.episode}`, tvdbEpisodes[index]));
    return {
      success: true,
      mapping,
      method: 'order',
      reason: 'regular-episode counts match',
      matchStats: { matched: providerEpisodes.length, skipped: 0, skipReasons: {} },
    };
  }

  const providerTitleCounts = new Map();
  for (const episode of providerEpisodes) {
    const title = normalizeTitle(episode.title);
    if (title) providerTitleCounts.set(title, (providerTitleCounts.get(title) || 0) + 1);
  }

  const tvdbByTitle = new Map();
  for (const episode of tvdbEpisodes) {
    const titles = new Set([episode.title, ...(episode.alternateTitles || [])]
      .map(normalizeTitle)
      .filter(Boolean));
    for (const title of titles) {
      if (!tvdbByTitle.has(title)) tvdbByTitle.set(title, []);
      tvdbByTitle.get(title).push(episode);
    }
  }

  const skipReasons = {};
  const usedTvdbIds = new Set();
  for (const providerEpisode of providerEpisodes) {
    const title = normalizeTitle(providerEpisode.title);
    if (!title) {
      incrementReason(skipReasons, 'missingTitle');
      continue;
    }
    if (isGenericEpisodeTitle(title)) {
      incrementReason(skipReasons, 'genericTitle');
      continue;
    }
    if (providerTitleCounts.get(title) !== 1) {
      incrementReason(skipReasons, 'duplicateProviderTitle');
      continue;
    }

    const exact = tvdbByTitle.get(title) || [];
    if (!exact.length) {
      incrementReason(skipReasons, 'noExactMatch');
      continue;
    }
    if (exact.length !== 1) {
      incrementReason(skipReasons, 'ambiguousTvdbTitle');
      continue;
    }

    const match = exact[0];
    if (usedTvdbIds.has(String(match.id))) {
      incrementReason(skipReasons, 'reusedTvdbEpisode');
      continue;
    }
    usedTvdbIds.add(String(match.id));
    mapping.set(`${providerEpisode.season}|${providerEpisode.episode}`, match);
  }

  const matchStats = {
    matched: mapping.size,
    skipped: providerEpisodes.length - mapping.size,
    skipReasons,
  };
  const reasonSummary = describeSkipReasons(skipReasons);
  if (!mapping.size) {
    return {
      success: false,
      mapping,
      method: 'title',
      reason: `regular-episode counts differ and no reliable exact title mappings exist${reasonSummary ? ` (${reasonSummary})` : ''}`,
      matchStats,
    };
  }
  return {
    success: true,
    mapping,
    method: 'title',
    reason: `regular-episode counts differ; ${mapping.size} matched and ${matchStats.skipped} skipped${reasonSummary ? ` (${reasonSummary})` : ''}`,
    matchStats,
  };
}

async function resolveTvdbSeriesId(imdbId) {
  const results = await authenticatedTvdbGet(`/search/remoteid/${encodeURIComponent(imdbId)}`);
  const ids = [...new Set((Array.isArray(results) ? results : [])
    .map(result => result?.series?.id)
    .filter(id => id != null)
    .map(String))];
  if (!ids.length) throw new Error('no TVDB series matched the IMDb ID');
  if (ids.length !== 1) throw new Error('the IMDb ID matched multiple TVDB series');
  return ids[0];
}

/**
 * Return export/submission-safe items whose season/episode metadata is canonical TVDB data.
 * Count mismatches may return a partial, reliable title mapping. A failure means
 * that no regular provider episode could be mapped safely for the series.
 */
async function mapSeriesItemsToTvdb(items, providerCatalog) {
  if (!items.length) return { success: true, items: [], method: 'none' };
  const imdbId = items[0].imdb_id;
  const catalog = normalizeProviderEpisodes(providerCatalog);
  const providerSpecialKeys = new Set(catalog
    .filter(episode => episode.isSpecial)
    .map(episode => `${episode.season}|${episode.episode}`));
  const regularItems = items.filter(item => {
    const season = Number(item.season);
    return Number.isInteger(season) && season > 0 && !providerSpecialKeys.has(`${item.season}|${item.episode}`);
  });
  const capturedSpecialsExcluded = items.length - regularItems.length;
  if (!regularItems.length) {
    const providerSpecialsExcluded = catalog.filter(episode => episode.isSpecial).length;
    return {
      success: true,
      items: [],
      method: 'specials-only',
      reason: 'all captured segments belong to provider specials',
      stats: { providerRegular: 0, tvdbRegular: 0, providerSpecialsExcluded, tvdbSpecialsExcluded: 0, capturedSpecialsExcluded },
    };
  }

  const providerEpisodes = catalog.filter(episode => !episode.isSpecial);
  const providerSpecialsExcluded = catalog.length - providerEpisodes.length;
  if (!providerEpisodes.length) {
    return { success: false, reason: 'provider regular-episode metadata is unavailable' };
  }
  const duplicateProviderNumber = findDuplicateNumber(providerEpisodes);
  if (duplicateProviderNumber) {
    return { success: false, reason: `provider metadata has duplicate regular episode number ${duplicateProviderNumber.replace('|', 'x')}` };
  }
  try {
    const tvdbSeriesId = await resolveTvdbSeriesId(imdbId);
    const requireTitleMatch = regularItems.every(item => item._tvdbRequireTitleMatch === true);
    const episodeList = await fetchTvdbEpisodeList(tvdbSeriesId, TVDB_EPISODE_LANGUAGE);
    const localizedEpisodes = await ensureTvdbEpisodeNameLanguage(episodeList, providerEpisodes, TVDB_EPISODE_LANGUAGE);
    logTvdbEpisodeLanguageAudit(tvdbSeriesId, TVDB_EPISODE_LANGUAGE, episodeList, localizedEpisodes);
    const tvdbCatalog = cleanTvdbEpisodes(localizedEpisodes);
    const tvdbEpisodes = tvdbCatalog.episodes;
    if (requireTitleMatch || providerEpisodes.length !== tvdbEpisodes.length) {
      const additionalLanguages = [...new Set(items.flatMap(item =>
        Array.isArray(item._tvdbEpisodeLanguages) ? item._tvdbEpisodeLanguages : []
      ).map(language => String(language || '').trim().toLowerCase()))]
        .filter(language => language && language !== TVDB_EPISODE_LANGUAGE);
      const alternateCatalogs = [];
      for (const language of additionalLanguages) {
        const alternateList = await fetchTvdbEpisodeList(tvdbSeriesId, language);
        const alternateLocalized = await ensureTvdbEpisodeNameLanguage(alternateList, providerEpisodes, language);
        logTvdbEpisodeLanguageAudit(tvdbSeriesId, language, alternateList, alternateLocalized);
        alternateCatalogs.push(cleanTvdbEpisodes(alternateLocalized));
      }
      mergeTvdbEpisodeTitles(tvdbCatalog, alternateCatalogs);
    }
    logTvdbEpisodeMatchTitles(tvdbSeriesId, providerEpisodes, tvdbEpisodes);
    if (!tvdbEpisodes.length) return { success: false, reason: 'TVDB returned no usable episode metadata' };
    const duplicateTvdbNumber = findDuplicateNumber(tvdbEpisodes);
    if (duplicateTvdbNumber) {
      return { success: false, reason: `TVDB metadata has duplicate regular episode number ${duplicateTvdbNumber.replace('|', 'x')}` };
    }
    const result = mapEpisodes(providerEpisodes, tvdbEpisodes, { requireTitleMatch });
    const stats = {
      providerRegular: providerEpisodes.length,
      tvdbRegular: tvdbEpisodes.length,
      providerSpecialsExcluded,
      tvdbSpecialsExcluded: tvdbCatalog.specialsExcluded,
      capturedSpecialsExcluded,
      regularEpisodesMatched: result.matchStats?.matched ?? 0,
      regularEpisodesSkipped: result.matchStats?.skipped ?? providerEpisodes.length,
      regularEpisodeSkipReasons: result.matchStats?.skipReasons || {},
    };
    if (!result.success) return { ...result, stats };

    const mappedItems = [];
    for (const item of regularItems) {
      const match = result.mapping.get(`${item.season}|${item.episode}`);
      if (!match) continue;
      const { _eid, _episodeTitle, _showId, _tvdbEpisodeLanguages, _tvdbRequireTitleMatch, ...submissionItem } = item;
      mappedItems.push({ ...submissionItem, season: match.season, episode: match.episode });
    }
    stats.capturedRegularSegmentsMatched = mappedItems.length;
    stats.capturedRegularSegmentsSkipped = regularItems.length - mappedItems.length;
    return { success: true, items: mappedItems, method: result.method, reason: result.reason, tvdbSeriesId, stats };
  } catch (error) {
    return { success: false, reason: error?.message || 'TVDB mapping failed' };
  }
}

function setProviderEpisodeCatalog(episodes, showId = state.showId) {
  const normalized = normalizeProviderEpisodes(episodes);
  const normalizedShowId = showId != null ? String(showId) : '';
  if (!normalizedShowId || normalizedShowId === state.showId) state.providerEpisodes = normalized;
  if (normalizedShowId) {
    state.providerEpisodesByShowId ||= {};
    state.providerEpisodesByShowId[normalizedShowId] = normalized;
  }
}

function recordProviderEpisode(episode, showId = state.showId) {
  const normalizedShowId = showId != null ? String(showId) : '';
  const previous = normalizedShowId
    ? state.providerEpisodesByShowId?.[normalizedShowId] || []
    : state.providerEpisodes || [];
  const current = normalizeProviderEpisodes([...previous, episode]);
  if (!normalizedShowId || normalizedShowId === state.showId) state.providerEpisodes = current;
  if (normalizedShowId) {
    state.providerEpisodesByShowId ||= {};
    state.providerEpisodesByShowId[normalizedShowId] = current;
  }
}


  // ─── config/provider-config.js ───

/**
 * Provider configuration layer
 * Defines shared Netflix panel styling and provider-specific settings
 */

/**
 * Base configuration for all providers
 */
const BASE_CONFIG = {
  INTRODB_BASE: 'https://api.introdb.app',
  IMDB_SUGGESTION_BASE: 'https://v3.sg.media-imdb.com',
};

/**
 * Netflix is the visual source of truth for every provider panel.
 * Provider configuration may only override button colors, provider-name color,
 * header/info-box text, and the info-box accent.
 */
const PANEL_COLORS = {
  background: 'rgba(12,12,12,0.98)',
  panelBg: '#181818',
  border: '#2c2c2c',
  text: '#fff',
  textSecondary: '#777',
  textMuted: '#444',
  accent: '#E50914',
};

/**
 * Provider-specific configurations
 * Each provider can customize button colors, provider-name color, header branding,
 * and info-box copy/accent.
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
    },
    nameColor: '#E50914',
    infoAccent: '#E50914',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically.',
  },
  disneyplus: {
    name: 'Disney+',
    match: 'https://www.disneyplus.com/*',
    colors: {
      primary: '#0063e5',
      primaryDark: '#004bb3',
      secondary: '#0c734f',
      secondaryDark: '#095a3d',
    },
    nameColor: '#0063e5',
    infoAccent: '#0063e5',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically.',
  },
  'prime-video': {
    name: 'Prime Video',
    match: 'https://*.primevideo.com/*',
    colors: {
      primary: '#00A8E1',
      primaryDark: '#008fbe',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#00A8E1',
    infoAccent: '#00A8E1',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'Segments are fetched per episode, so all seasons and episodes must be checked.',
  },
  hbo: {
    name: 'HBO Max',
    match: 'https://play.max.com/*',
    colors: {
      primary: '#8a2be2',
      primaryDark: '#6a1b9e',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#8a2be2',
    infoAccent: '#8a2be2',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically.',
  },
  videoland: {
    name: 'Videoland',
    match: 'https://www.videoland.com/*',
    colors: {
      primary: '#e0303d',
      primaryDark: '#3C0919',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#e0303d',
    infoAccent: '#e0303d',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'Segments are fetched per episode, so all seasons and episodes must be checked.',
  },
  skyshowtime: {
    name: 'SkyShowtime',
    match: 'https://www.skyshowtime.com/*',
    colors: {
      primary: '#a3127e',
      primaryDark: '#841b94',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#a3127e',
    infoAccent: '#a3127e',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically from SkyShowtime catalogue metadata.',
  },
  crunchyroll: {
    name: 'Crunchyroll',
    match: 'https://www.crunchyroll.com/*',
    colors: {
      primary: '#f47521',
      primaryDark: '#c85d17',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#f47521',
    infoAccent: '#f47521',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'Segments are fetched per episode, so all seasons and episodes must be checked.',
  },
  'apple-tv': {
    name: 'Apple TV',
    match: 'https://tv.apple.com/*',
    colors: {
      primary: '#0071e3',
      primaryDark: '#005bb5',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#f5f5f7',
    infoAccent: '#0071e3',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All episodes are attempted automatically; unavailable timestamps fall back to per-episode playback.',
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
  crunchyroll: {
    intro: SEGMENT_TYPES.INTRO,
    recap: SEGMENT_TYPES.RECAP,
    credits: SEGMENT_TYPES.OUTRO,
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
 * @param {string} [params.showId] - Provider series identifier used to isolate multiple series
 * @param {string} [params.episodeTitle] - Provider episode title used only for TVDB mapping
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
  imdbId = 'IMDB_PENDING',
  showId = '',
  episodeTitle = ''
}) {
  const segmentType = normalizeSegmentType(providerSegmentType, providerName);
  if (!segmentType) return null;
  
  return {
    _eid: episodeId,
    _episodeTitle: episodeTitle,
    ...(showId ? { _showId: String(showId) } : {}),
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


  // ─── providers/timestamp-logger.js ───

/** Shared, provider-agnostic logging for newly captured episode timestamps. */

/** Format seconds as mm:ss.mmm, adding hours only when needed. */
function formatCapturedTimestamp(seconds) {
  const numericSeconds = Number(seconds);
  if (!Number.isFinite(numericSeconds)) return '';

  const totalMilliseconds = Math.max(0, Math.round(numericSeconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const remainingSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const clock = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock;
}

/** Log one episode in the same structured shape for every provider. */
function logCapturedTimestamps({
  prefix,
  showTitle,
  season,
  episode,
  episodeTitle = '',
  providerIdLabel = 'providerId',
  providerId = '',
  items = [],
}) {
  if (!items.length) return;

  const episodeLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const details = {
    title: episodeTitle || '',
    ...(providerId != null && providerId !== '' ? { [providerIdLabel]: providerId } : {}),
    segments: items.map(item => ({
      type: item.segment_type,
      start: formatCapturedTimestamp(item.start_sec),
      end: formatCapturedTimestamp(item.end_sec),
      start_sec: item.start_sec,
      end_sec: item.end_sec,
    })),
  };
  console.info(`[${prefix}] Captured timestamps · ${showTitle || 'Unknown series'} · ${episodeLabel}`, details);
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
  const { colors: providerColors, branding, infoAccent, nameColor } = config;
  const colors = PANEL_COLORS;
  
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
    font-size:13px; line-height:normal; box-sizing:border-box; box-shadow:0 16px 48px rgba(0,0,0,0.85);
    transition:opacity 0.18s; user-select:none; display:none; opacity:0;
  `;

  panel.innerHTML = `
    <style>
      #nfe-panel, #nfe-panel * {
        box-sizing:border-box; font-family:-apple-system,Arial,sans-serif;
        font-style:normal; text-shadow:none;
      }
      #nfe-panel button, #nfe-panel input {
        min-width:0; margin:0; font-family:-apple-system,Arial,sans-serif;
        font-style:normal; line-height:normal; letter-spacing:normal; text-transform:none;
        appearance:none; -webkit-appearance:none;
      }
      #nfe-panel button, #nfe-panel input { min-height:0; }
    </style>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700;color:${nameColor}">${config.name} ${branding.title}</span>
      <button id="nfe-close" style="background:none;border:none;color:${colors.textMuted};font-size:18px;cursor:pointer;line-height:1;padding:0;transition:color 0.15s"
        onmouseenter="this.style.color='${colors.text}'" onmouseleave="this.style.color='${colors.textMuted}'">✕</button>
    </div>

    <div id="nfe-title-display" style="color:${colors.textSecondary};font-size:11px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:13px"></div>

    <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
      <div id="nfe-imdb-status" style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:7px">IMDb ID: ${state.imdbId || 'Not set'}</div>
      <div style="display:flex;gap:4px">
        <input id="nfe-imdb-input" type="text" placeholder="ID (e.g. tt123456)..." value="${state.imdbId}"
          style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                 padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
          onfocus="this.style.borderColor='${colors.accent}'" onblur="this.style.borderColor='#303030'"/>
        <button id="nfe-imdb-search" title="Search by title on IMDb"
          style="background:#242424;border:1px solid #303030;border-radius:6px;color:#bbb;
                 padding:6px 8px;cursor:pointer;font-size:12px;transition:background 0.15s"
          onmouseenter="this.style.background='#2e2e2e'" onmouseleave="this.style.background='#242424'">Search</button>
        <button id="nfe-imdb-set"
          style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                 padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
          onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">OK</button>
      </div>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:8px">
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-ts"    style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div id="nfe-cnt-segments-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Segments</div>
      </div>
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-req"   style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div id="nfe-cnt-series-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Series</div>
      </div>
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-files" style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div id="nfe-cnt-files-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Files</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
      <div style="flex:1;height:1px;background:${colors.border}"></div>
      <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">MANUAL / BULK UPLOAD</span>
      <div style="flex:1;height:1px;background:${colors.border}"></div>
    </div>

    <div style="border-left:2px solid ${infoAccent};padding:6px 9px;margin-bottom:8px;font-size:11px;color:${colors.textMuted};line-height:1.4;background:${colors.panelBg};border-radius:0 7px 7px 0">
      ${config.captureHint}
    </div>

    <button id="nfe-export"
      style="width:100%;background:${providerColors.primary};border:none;border-radius:8px;color:#fff;
             padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
             transition:background 0.15s"
      onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">
      Download JSON(s)
    </button>

     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">TVDB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">Your TVDB API Key</div>
       <input id="nfe-tvdb-apikey-input" type="password" placeholder="Enter your TVDB API key..."
         style="width:100%;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                padding:6px 8px;font-size:12px;outline:none;margin-bottom:5px"/>
       <div style="display:flex;gap:4px">
         <input id="nfe-tvdb-pin-input" type="password" placeholder="Subscriber PIN (optional)"
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none"/>
         <button id="nfe-tvdb-set"
           style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700">Save</button>
       </div>
       <div id="nfe-tvdb-status" style="font-size:11px;color:${colors.textSecondary};margin-top:6px;line-height:1.4;${state.tvdbApiKey ? '' : 'display:none;'}">${state.tvdbApiKey ? 'TVDB credentials saved locally' : ''}</div>
       <div style="font-size:9px;color:${colors.textMuted};margin-top:5px">Episode metadata provided by <a href="https://thetvdb.com" target="_blank" rel="noopener noreferrer" style="color:${colors.textSecondary}">TheTVDB</a>.</div>
     </div>

     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">INTRODB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">API Key</div>
       <div style="display:flex;gap:4px">
         <input id="nfe-apikey-input" type="password" placeholder="Enter your IntroDB API key..."
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
           onfocus="this.style.borderColor='${colors.accent}'" onblur="this.style.borderColor='#303030'"/>
         <button id="nfe-apikey-set"
           style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
           onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">Save</button>
       </div>
     </div>

     <div id="nfe-introdb-status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:6px;line-height:1.4;text-align:center;${state.introdbApiKey ? '' : 'display:none;'}">${state.introdbApiKey ? 'API key saved locally' : ''}</div>

     <button id="nfe-submit"
       style="width:100%;background:${providerColors.secondary};border:none;border-radius:8px;color:#fff;
              padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
              transition:background 0.15s"
       onmouseenter="this.style.background='${providerColors.secondaryDark}'" onmouseleave="this.style.background='${providerColors.secondary}'">
       Submit to IntroDB
     </button>

    <button id="nfe-clear"
      style="width:100%;margin-top:12px;background:transparent;border:1px solid #222;border-radius:8px;
             color:${colors.textMuted};padding:7px;cursor:pointer;font-size:12px;transition:all 0.15s"
      onmouseenter="this.style.borderColor='#444';this.style.color='#888'"
      onmouseleave="this.style.borderColor='#222';this.style.color='${colors.textMuted}'">
      Clear data
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
    const tvdbSetBtn = document.getElementById('nfe-tvdb-set');
    const tvdbInputs = [document.getElementById('nfe-tvdb-apikey-input'), document.getElementById('nfe-tvdb-pin-input')];
    
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
    if (tvdbSetBtn) tvdbSetBtn.addEventListener('click', () => {
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onTvdbSet) window.nfePanelCallbacks.onTvdbSet();
    });
    tvdbInputs.filter(Boolean).forEach(input => input.addEventListener('keydown', event => {
      if (event.key === 'Enter') tvdbSetBtn?.click();
    }));
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
  const segmentsLabel = $('nfe-cnt-segments-label');
  if (segmentsLabel) segmentsLabel.textContent = state.allItems.length === 1 ? 'Segment' : 'Segments';
  
  const rq = $('nfe-cnt-req');
  if (rq) rq.textContent = state.showIds.size;
  
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
    const filesLabel = $('nfe-cnt-files-label');
    if (filesLabel) filesLabel.textContent = fileTotal === 1 ? 'File' : 'Files';
  }
}

/**
 * Update the panel title with show information
 */
function updatePanelTitle() {
  const el = document.getElementById('nfe-title-display');
  if (!el) return;
  el.textContent = state.showTitle 
    ? `${state.showTitle}${state.showYear ? ` (${state.showYear})` : ''}`
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
  if (inp) inp.value = '';
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

  const { colors: providerColors, name: providerName } = getProviderConfig(currentProvider);
  const colors = PANEL_COLORS;
  const overlay = document.createElement('div');
  overlay.id = 'nfe-export-preview';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center;
    justify-content:center; padding:24px; background:rgba(0,0,0,.72); box-sizing:border-box;
  `;

  const dialog = document.createElement('section');
  dialog.style.cssText = `
    width:min(760px, 100%); max-height:calc(100vh - 48px); display:flex; flex-direction:column;
    padding:18px; border:1px solid ${colors.border}; border-radius:12px; background:${colors.background};
    color:${colors.text}; font:13px/normal -apple-system,Arial,sans-serif; box-sizing:border-box;
    box-shadow:0 16px 48px rgba(0,0,0,.85);
  `;

  const heading = document.createElement('h2');
  heading.textContent = `Review ${providerName} JSON export`;
  heading.style.cssText = `margin:0 0 6px; color:${providerColors.primary}; font:700 16px/normal -apple-system,Arial,sans-serif;`;
  const summary = document.createElement('p');
  const timestampLabel = items.length === 1 ? 'timestamp' : 'timestamps';
  const fileLabel = fileCount === 1 ? 'file' : 'files';
  const duplicateSummary = duplicateCount
    ? `; ${duplicateCount} ${duplicateCount === 1 ? 'duplicate' : 'duplicates'} excluded`
    : '';
  summary.textContent = `${items.length} ${timestampLabel} in ${fileCount} ${fileLabel}${duplicateSummary}.`;
  summary.style.cssText = `margin:0 0 12px; color:${colors.textSecondary}; font:13px/normal -apple-system,Arial,sans-serif;`;
  const preview = document.createElement('pre');
  preview.textContent = JSON.stringify({ items }, null, 2);
  preview.style.cssText = `
    overflow:auto; flex:1; min-height:180px; margin:0 0 14px; padding:12px; border-radius:8px;
    background:${colors.panelBg}; color:${colors.text}; box-sizing:border-box;
    font:11px/normal ui-monospace,Consolas,monospace; white-space:pre-wrap;
  `;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; font:13px/normal -apple-system,Arial,sans-serif; cursor:pointer;';
  const confirm = document.createElement('button');
  confirm.textContent = 'Download JSON';
  confirm.style.cssText = `box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:0; border-radius:6px; background:${providerColors.primary}; color:#fff; font:700 13px/normal -apple-system,Arial,sans-serif; cursor:pointer;`;

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

  // ─── providers/bootstrap.js ───

/**
 * Shared provider bootstrap and control flow.
 * The Netflix UI/controls are the single source of truth for every provider.
 */
const BUTTON_IDLE_DELAY_MS = 3000;
let activeProviderConfig = getProviderConfig('netflix');
let buttonHideTimer;

function getItemShowId(item) {
  return item?._showId != null ? String(item._showId) : '';
}

function applyImdbIdToShow(imdbId, showId, { overwrite = false } = {}) {
  const normalizedShowId = showId != null ? String(showId) : '';
  const hasTaggedItems = state.allItems.some(item => getItemShowId(item));
  state.allItems.forEach(item => {
    const belongsToShow = normalizedShowId
      ? getItemShowId(item) === normalizedShowId || (!hasTaggedItems && !getItemShowId(item))
      : !getItemShowId(item);
    const canUpdate = overwrite || !item.imdb_id || item.imdb_id === 'IMDB_PENDING';
    if (belongsToShow && canUpdate) item.imdb_id = imdbId;
  });
  if (normalizedShowId) {
    state.imdbIdsByShowId ||= {};
    state.imdbIdsByShowId[normalizedShowId] = imdbId;
  }
}

function setDbStatus(msg) {
  state.dbStatusMsg = msg;
  const el = document.getElementById('nfe-imdb-status');
  if (el) el.textContent = `IMDb ID: ${state.imdbId || 'Not set'}`;
}

function setIntrodbStatus(msg) {
  const el = document.getElementById('nfe-introdb-status');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function setTvdbStatus(msg) {
  const el = document.getElementById('nfe-tvdb-status');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

/** Apply the shared IMDb flow after an extractor discovers a show. */
function handleDetectedShow({ title, showId = null, year = '', imdbOverride = null }) {
  const normalizedShowId = showId != null ? String(showId) : null;
  const showChanged = Boolean(title) && (
    title !== state.showTitle ||
    (normalizedShowId && normalizedShowId !== state.showId)
  );
  if (showChanged) {
    state.showTitle = title;
    state.showId = normalizedShowId;
    if (state.showId) state.showIds.add(state.showId);
    state.showYear = year ? String(year) : '';
    state.dbSearchDone = false;
    state.imdbId = '';
    state.dedupCacheV2 = {};
    state.providerEpisodes = [];
    updatePanelTitle();
  }

  if (state.dbSearchDone || !state.showTitle) return;
  state.dbSearchDone = true;

  const lookupTitle = state.showTitle;
  const lookupYear = state.showYear;
  const lookupShowId = state.showId;
  const isCurrentShow = () => lookupShowId
    ? state.showId === lookupShowId
    : state.showTitle === lookupTitle;

  const cachedImdbId = lookupShowId && state.imdbIdsByShowId?.[lookupShowId];
  if (!imdbOverride && cachedImdbId) {
    state.imdbId = cachedImdbId;
    applyImdbIdToShow(cachedImdbId, lookupShowId);
    updateImdbInput();
    setDbStatus(`Found: ${cachedImdbId}`);
    updateCounters();
    return;
  }

  if (imdbOverride) {
    state.imdbId = imdbOverride;
    applyImdbIdToShow(imdbOverride, lookupShowId);
    updateImdbInput();
    setDbStatus(`Manual override applied · ID: ${imdbOverride}`);
    updateCounters();
    loadExistingSegments(imdbOverride);
    return;
  }

  searchImdbByTitle(lookupTitle, lookupYear).then(result => {
    if (result.success) {
      applyImdbIdToShow(result.imdbId, lookupShowId);
      if (!isCurrentShow()) return;
      state.imdbId = result.imdbId;
      updateImdbInput();
      setDbStatus(`Found: ${result.imdbId}`);
      updateCounters();
      loadExistingSegments(result.imdbId);
    } else {
      if (!isCurrentShow()) return;
      setDbStatus(`IMDb lookup failed: ${result.error}`);
    }
  }).catch(error => {
    console.error('[NFE] IMDb search error:', error);
    if (!isCurrentShow()) return;
    setDbStatus('IMDb lookup error');
  });
}

/** Store extractor output and update the shared counters/toast identically. */
function recordExtractedSegments(items) {
  if (!items.length) return;
  state.allItems.push(...items);
  state.interceptedCount++;
  updateCounters();
  toast(`+${items.length} timestamps captured · total: ${state.allItems.length}`);
}

function isAlreadyInIntroDB(item) {
  const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
  return state.dedupCacheV2[key]?.has(item.segment_type) ?? false;
}

async function mapCapturedItemsWithTvdb(action) {
  const capturedItems = state.allItems.slice();
  const pendingItems = capturedItems.filter(item => !item.imdb_id || item.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length) {
    toast(`${pendingItems.length} timestamp(s) without an IMDb ID will be skipped from ${action}.`);
  }

  const seriesGroups = new Map();
  for (const item of capturedItems.filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')) {
    if (!seriesGroups.has(item.imdb_id)) seriesGroups.set(item.imdb_id, []);
    seriesGroups.get(item.imdb_id).push(item);
  }

  const items = [];
  let unreliableSkipped = 0;
  let specialSegmentsExcluded = 0;
  const reasonLabels = {
    genericTitle: 'generic title',
    missingTitle: 'missing title',
    duplicateProviderTitle: 'duplicate provider title',
    noExactMatch: 'no exact normalized TVDB match',
    ambiguousTvdbTitle: 'ambiguous TVDB title',
    reusedTvdbEpisode: 'TVDB episode already matched',
  };
  const describeReasons = reasons => Object.entries(reasons || {})
    .map(([reason, count]) => `${reasonLabels[reason] || reason}: ${count}`)
    .join(', ') || 'none';
  for (const [imdbId, seriesItems] of seriesGroups) {
    const showId = getItemShowId(seriesItems[0]);
    const catalog = showId
      ? state.providerEpisodesByShowId?.[showId] || []
      : (imdbId === state.imdbId ? state.providerEpisodes : []);
    const mapped = await mapSeriesItemsToTvdb(seriesItems, catalog);
    const stats = mapped.stats;
    if (!mapped.success) {
      unreliableSkipped += seriesItems.length;
      const counts = stats ? ` Provider regular: ${stats.providerRegular}; TVDB regular: ${stats.tvdbRegular}; provider specials excluded: ${stats.providerSpecialsExcluded}; TVDB Season 0 excluded: ${stats.tvdbSpecialsExcluded}.` : '';
      const titleCounts = stats ? ` Regular episodes matched: ${stats.regularEpisodesMatched ?? 0}; skipped: ${stats.regularEpisodesSkipped ?? stats.providerRegular}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}.` : '';
      console.warn(`[NFE-TVDB] Skipping series ${imdbId} from ${action}: ${mapped.reason}.${counts}${titleCounts}`);
      continue;
    }

    specialSegmentsExcluded += stats?.capturedSpecialsExcluded || 0;
    unreliableSkipped += stats?.capturedRegularSegmentsSkipped || 0;
    if (mapped.method === 'order') {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: regular counts match (${stats.providerRegular}); mapped by TVDB order. Regular episodes matched: ${stats.regularEpisodesMatched}; skipped: ${stats.regularEpisodesSkipped}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}. Provider specials excluded: ${stats.providerSpecialsExcluded}; TVDB Season 0 excluded: ${stats.tvdbSpecialsExcluded}; captured regular segments omitted: ${stats.capturedRegularSegmentsSkipped}; captured special segments omitted: ${stats.capturedSpecialsExcluded}.`);
    } else if (mapped.method === 'title') {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: regular counts differ (provider ${stats.providerRegular}, TVDB ${stats.tvdbRegular}); retained reliable exact normalized one-to-one title mappings. Regular episodes matched: ${stats.regularEpisodesMatched}; skipped: ${stats.regularEpisodesSkipped}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}. Provider specials excluded: ${stats.providerSpecialsExcluded}; TVDB Season 0 excluded: ${stats.tvdbSpecialsExcluded}; captured regular segments omitted: ${stats.capturedRegularSegmentsSkipped}; captured special segments omitted: ${stats.capturedSpecialsExcluded}.`);
    } else {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: no regular segments included (${mapped.reason}); captured special segments omitted: ${stats?.capturedSpecialsExcluded || 0}.`);
    }
    items.push(...mapped.items);
  }

  if (unreliableSkipped) {
    toast(`${unreliableSkipped} timestamp(s) skipped from ${action} because TVDB mapping was not reliable.`);
  }
  return {
    items,
    capturedItems,
    pendingSkipped: pendingItems.length,
    unreliableSkipped,
    specialSegmentsExcluded,
  };
}

const MIN_OUTPUT_SEGMENT_DURATION_SECONDS = 5;

function filterShortOutputSegments(items) {
  return items.filter(item => {
    const start = Number(item?.start_sec);
    const end = Number(item?.end_sec);
    return Number.isFinite(start)
      && Number.isFinite(end)
      && end - start >= MIN_OUTPUT_SEGMENT_DURATION_SECONDS;
  });
}

async function exportJSON() {
  if (!state.allItems.length) {
    toast('No timestamps yet.');
    return;
  }
  if (!state.tvdbApiKey) {
    toast('Please enter your own TVDB API key before exporting JSON.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  toast('Validating JSON export against TVDB...');
  const mapped = await mapCapturedItemsWithTvdb('JSON export');
  const mappedItems = mapped.items;
  let items = filterShortOutputSegments(mappedItems);
  const shortSegmentCount = mappedItems.length - items.length;
  if (shortSegmentCount > 0) {
    toast(`${shortSegmentCount} segment(s) shorter than ${MIN_OUTPUT_SEGMENT_DURATION_SECONDS} seconds removed from export.`);
  }
  if (!items.length) {
    if (mappedItems.length && shortSegmentCount === mappedItems.length) {
      toast(`All mapped segments are shorter than ${MIN_OUTPUT_SEGMENT_DURATION_SECONDS} seconds; nothing was exported.`);
      return;
    }
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    toast(onlySpecials ? 'Only provider specials were captured; nothing was exported.' : 'No series has a reliable TVDB episode mapping; nothing was exported.');
    return;
  }

  const episodeKeys = [...new Set(
    items
      .map(item => createEpisodeCacheKey(item.imdb_id, item.season, item.episode))
  )];
  toast(`Checking IntroDB for existing segments (${episodeKeys.length} canonical episode(s))...`);
  const canonicalExisting = new Map(await Promise.all(episodeKeys.map(async key => [
    key,
    await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
  ])));

  const beforeCount = items.length;
  items = items.filter(item => {
    const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
    return !canonicalExisting.get(key)?.has(item.segment_type);
  });
  const duplicateCount = beforeCount - items.length;
  if (duplicateCount > 0) toast(`${duplicateCount} duplicate(s) already in IntroDB removed from export.`);
  if (!items.length) {
    toast('Nothing left to export after removing duplicates.');
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const key = item.imdb_id || 'no_id';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const files = [];
  const maxItemsPerFile = 100;
  for (const [imdbId, groupItems] of groups) {
    const total = Math.ceil(groupItems.length / maxItemsPerFile);
    for (let index = 0; index < total; index++) {
      files.push({
        imdbId,
        part: total > 1 ? `_part${index + 1}of${total}` : '',
        data: groupItems.slice(index * maxItemsPerFile, (index + 1) * maxItemsPerFile),
      });
    }
  }

  let downloaded = 0;
  function downloadNext(index) {
    if (index >= files.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${items.length} entries`);
      return;
    }
    const file = files[index];
    const blob = new Blob([JSON.stringify({ items: file.data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), {
      href: url,
      download: `timestamps_${file.imdbId}${file.part}.json`,
    });
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    downloaded++;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTimeout(() => downloadNext(index + 1), 400);
  }

  showExportPreview({
    items,
    fileCount: files.length,
    duplicateCount,
    onConfirm: () => downloadNext(0),
  });
}

function updateSubmitBtn(label) {
  const button = document.getElementById('nfe-submit');
  if (button) button.textContent = label;
}

async function submitToIntroDB() {
  if (!state.allItems.length) {
    toast('No timestamps to submit.');
    return;
  }
  if (!state.introdbApiKey) {
    toast('Please enter your IntroDB API key in the panel above.');
    setIntrodbStatus('No API key configured');
    return;
  }
  if (!state.tvdbApiKey) {
    toast('Please enter your own TVDB API key in the panel above.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  state.submitInProgress = true;
  updateSubmitBtn('Checking TVDB...');
  const stopSubmission = () => {
    state.submitInProgress = false;
    updateSubmitBtn('Submit to IntroDB');
  };

  const mapped = await mapCapturedItemsWithTvdb('IntroDB submission');
  const capturedItems = mapped.capturedItems;
  const mappedItems = mapped.items;
  const allMapped = filterShortOutputSegments(mappedItems);
  const shortSegmentCount = mappedItems.length - allMapped.length;
  if (shortSegmentCount > 0) {
    toast(`${shortSegmentCount} segment(s) shorter than ${MIN_OUTPUT_SEGMENT_DURATION_SECONDS} seconds skipped.`);
  }
  if (!allMapped.length) {
    if (mappedItems.length && shortSegmentCount === mappedItems.length) {
      toast(`All mapped segments are shorter than ${MIN_OUTPUT_SEGMENT_DURATION_SECONDS} seconds; nothing was submitted.`);
      setIntrodbStatus(`Nothing submitted: segments must be at least ${MIN_OUTPUT_SEGMENT_DURATION_SECONDS} seconds`);
      stopSubmission();
      return;
    }
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    toast(onlySpecials ? 'Only provider specials were captured; nothing was submitted.' : 'No series has a reliable TVDB episode mapping; nothing was submitted.');
    setIntrodbStatus(onlySpecials ? 'Nothing submitted: specials are excluded' : 'Submission blocked: TVDB mapping unavailable or unreliable');
    stopSubmission();
    return;
  }

  const episodeKeys = [...new Set(
    allMapped
      .filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')
      .map(item => createEpisodeCacheKey(item.imdb_id, item.season, item.episode))
  )];
  toast(`Checking IntroDB for existing segments (${episodeKeys.length} canonical episode(s))...`);
  const canonicalExisting = new Map(await Promise.all(episodeKeys.map(async key => [
    key,
    await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
  ])));

  const items = allMapped.filter(item => {
    const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
    return !canonicalExisting.get(key)?.has(item.segment_type);
  });
  const skipped = capturedItems.length - items.length;
  if (!items.length) {
    toast('All timestamps already exist in IntroDB.');
    setIntrodbStatus('Nothing new to submit (all duplicates)');
    stopSubmission();
    return;
  }

  const skipMessage = skipped > 0 ? ` (${skipped} skipped or already existed)` : '';
  const ids = [...new Set(items.map(item => item.imdb_id))].join(', ');
  if (!confirm(`Submit ${items.length} timestamp${items.length !== 1 ? 's' : ''} to IntroDB?${skipMessage}\nID(s): ${ids}`)) {
    stopSubmission();
    return;
  }

  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn(`Submitting 0/${items.length}...`);
  let sent = 0;

  function sendNext(index) {
    if (index >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('Submit to IntroDB');
      toast(`IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      setIntrodbStatus(`${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      return;
    }

    const item = items[index];
    submitSegment(item, state.introdbApiKey).then(result => {
      sent++;
      if (result.success) {
        state.submitResults.ok++;
      } else {
        state.submitResults.fail++;
        console.warn('[NFE] IntroDB rejected:', result.status, item);
      }
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(index + 1), 150);
    }).catch(() => {
      sent++;
      state.submitResults.fail++;
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(index + 1), 150);
    });
  }

  sendNext(0);
}

function clearData() {
  if (!confirm('Delete all captured timestamps?')) return;
  const introdbApiKey = state.introdbApiKey;
  const { apiKey: tvdbApiKey, pin: tvdbPin } = loadTvdbSettings();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, createState(activeProviderConfig.name), { introdbApiKey, tvdbApiKey, tvdbPin });
  updateCounters();
  updatePanelTitle();
  setDbStatus(`Waiting for ${activeProviderConfig.name} metadata...`);
  setIntrodbStatus('');
  updateImdbInput();
  toast('Data cleared');
}

function configurePanelCallbacks() {
  window.nfePanelCallbacks = {
    onClose: closePanel,
    onExport: exportJSON,
    onSubmit: submitToIntroDB,
    onClear: clearData,
    onImdbSet: () => {
      const value = document.getElementById('nfe-imdb-input').value.trim();
      if (!value) return;
      state.imdbId = value;
      applyImdbIdToShow(value, state.showId, { overwrite: true });
      state.dedupCacheV2 = {};
      setDbStatus(`ID saved: ${value}`);
      updateCounters();
      loadExistingSegments(value);
      lookupImdbTitle(value).then(result => {
        if (!result.success) return;
        state.showTitle = result.title;
        state.showYear = result.year ? String(result.year) : '';
        updatePanelTitle();
      });
    },
    onImdbSearch: () => {
      const manual = document.getElementById('nfe-imdb-input').value.trim();
      const query = manual || state.showTitle;
      if (!query) { toast('No title detected yet.'); return; }
      state.dbSearchDone = false;
      state.dedupCacheV2 = {};
      const searchShowId = state.showId;
      searchImdbByTitle(query, state.showYear).then(result => {
        if (result.success) {
          applyImdbIdToShow(result.imdbId, searchShowId);
          if (searchShowId && state.showId !== searchShowId) return;
          state.imdbId = result.imdbId;
          updateImdbInput();
          setDbStatus(`Found: ${result.imdbId}`);
          updateCounters();
          loadExistingSegments(result.imdbId);
        } else {
          setDbStatus(`IMDb lookup failed: ${result.error}`);
        }
      }).catch(error => {
        console.error('[NFE] Manual IMDb search error:', error);
        setDbStatus('IMDb lookup error');
      });
    },
    onApikeySet: () => {
      const value = document.getElementById('nfe-apikey-input').value.trim();
      if (!value) {
        toast('Please enter an IntroDB API key.');
        return;
      }
      saveIntrodbSettings(value);
      document.getElementById('nfe-apikey-input').value = '';
      setIntrodbStatus('API key saved locally');
      toast('IntroDB API key saved locally');
    },
    onTvdbSet: () => {
      const apiKey = document.getElementById('nfe-tvdb-apikey-input').value.trim();
      const pin = document.getElementById('nfe-tvdb-pin-input').value.trim();
      if (!apiKey) {
        toast('Please enter your own TVDB API key.');
        setTvdbStatus('No TVDB API key configured');
        return;
      }
      saveTvdbSettings(apiKey, pin);
      document.getElementById('nfe-tvdb-apikey-input').value = '';
      document.getElementById('nfe-tvdb-pin-input').value = '';
      setTvdbStatus('TVDB credentials saved locally');
      toast('TVDB credentials saved locally');
    },
  };
}

function setupPanelHandler() {
  document.addEventListener('click', event => {
    const panel = document.getElementById('nfe-panel');
    const button = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(event.target) && !button?.contains(event.target)) closePanel();
  }, true);
}

function syncVisibility() {
  const controls =
    document.querySelector('[data-uia="controls-standard"]') ||
    document.querySelector('[class*="PlayerControls"]') ||
    document.querySelector('.watch-video--bottom-controls-container');
  if (!controls || !state.panelVisible) return;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  const visible = parseFloat(getComputedStyle(controls).opacity) > 0.05;
  panel.style.opacity = visible ? '1' : '0';
  panel.style.pointerEvents = visible ? 'auto' : 'none';
}

function setButtonVisibility(visible) {
  const button = document.getElementById('nfe-btn');
  if (!button) return;
  button.style.opacity = visible ? '0.85' : '0';
  button.style.pointerEvents = visible ? 'auto' : 'none';
}

function resetButtonIdleTimer() {
  clearTimeout(buttonHideTimer);
  setButtonVisibility(true);
  buttonHideTimer = setTimeout(() => setButtonVisibility(false), BUTTON_IDLE_DELAY_MS);
}

function setupControlVisibilityHandler() {
  document.addEventListener('mousemove', () => {
    resetButtonIdleTimer();
    syncVisibility();
    setTimeout(syncVisibility, 250);
  }, true);
}

function bootstrapProvider({
  providerName,
  setupInterception,
  isPlayerPage = () => true,
}) {
  activeProviderConfig = getProviderConfig(providerName);
  Object.assign(state, createState(activeProviderConfig.name));
  loadIntrodbSettings();
  loadTvdbSettings();
  setProviderName(providerName);
  configurePanelCallbacks();
  setupInterception();
  setupPanelHandler();
  setupControlVisibilityHandler();

  let lastPath = location.pathname;
  setInterval(() => {
    const inPlayer = isPlayerPage();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      document.getElementById('nfe-btn')?.remove();
      if (!inPlayer) {
        document.getElementById('nfe-panel')?.remove();
        state.panelVisible = false;
      }
    }
    if (inPlayer) {
      const buttonMissing = !document.getElementById('nfe-btn');
      injectBtn(providerName, getNextEpBtn);
      if (buttonMissing) resetButtonIdleTimer();
      syncVisibility();
    }
  }, 1000);

  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  win.__segmentScraper = {
    getAll: () => state.allItems,
    get state() {
      const { introdbApiKey, tvdbApiKey, tvdbPin, ...publicState } = state;
      return publicState;
    },
  };
}


  // Provider registration: netflix
  if (location.hostname === 'www.netflix.com' || location.hostname === 'netflix.com') {

  // â”€â”€â”€ providers/netflix/extractor.js â”€â”€â”€

/** Netflix-specific metadata interception and segment extraction. */



const NETFLIX_TITLE_OVERRIDES = {
  '81748089': 'tt2431250',
};

function isNetflixSpecialSeason(season) {
  if (Number(season?.seq) === 0 || season?.isSpecial === true) return true;
  const specialTypes = new Set(['special', 'specials', 'supplemental', 'bonus', 'extras', 'trailer', 'trailers']);
  const type = String(season?.type || season?.seasonType || '').trim().toLowerCase();
  if (specialTypes.has(type)) return true;
  const label = String(season?.name || season?.shortName || season?.title || '').trim().toLowerCase();
  return /^(?:specials?|bonus|extras|trailers?\s*(?:&|and)\s*more)$/.test(label);
}

function isNetflixSpecialEpisode(season, episode) {
  if (isNetflixSpecialSeason(season) || episode?.isSpecial === true) return true;
  const type = String(episode?.type || episode?.episodeType || '').trim().toLowerCase();
  return ['special', 'supplemental', 'bonus', 'extra', 'trailer'].includes(type);
}

function processNetflixMetadata(data) {
  const video = data.video;
  if (!video) return;

  const showId = video.id != null ? String(video.id) : null;
  const year = video.seasons?.[0]?.year || '';
  handleDetectedShow({
    title: video.title,
    showId,
    year,
    imdbOverride: showId ? NETFLIX_TITLE_OVERRIDES[showId] : null,
  });

  setProviderEpisodeCatalog((video.seasons || []).flatMap(season =>
    (season.episodes || []).map(episode => ({
      providerId: episode.episodeId || episode.id,
      season: season.seq,
      episode: episode.seq,
      title: episode.title || episode.name || '',
      isSpecial: isNetflixSpecialEpisode(season, episode),
    }))
  ), showId);

  const extractedItems = [];
  for (const season of video.seasons || []) {
    for (const episode of season.episodes || []) {
      const episodeId = episode.episodeId || episode.id;
      if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;

      const common = {
        providerName: 'netflix',
        episodeId,
        showId,
        season: season.seq,
        episode: episode.seq,
        imdbId: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
        episodeTitle: episode.title || episode.name || '',
      };
      const markers = episode.skipMarkers || {};
      const segments = [
        markers.recap?.end > 0 && {
          providerSegmentType: 'recap',
          startSec: markers.recap.start / 1000,
          endSec: markers.recap.end / 1000,
        },
        markers.credit?.end > 0 && {
          providerSegmentType: 'credit',
          startSec: markers.credit.start / 1000,
          endSec: markers.credit.end / 1000,
        },
        markers.intro?.end > 0 && {
          providerSegmentType: 'intro',
          startSec: markers.intro.start / 1000,
          endSec: markers.intro.end / 1000,
        },
        episode.creditsOffset && episode.runtime && {
          providerSegmentType: 'creditsOffset',
          startSec: parseFloat(episode.creditsOffset),
          endSec: parseFloat(episode.runtime),
        },
      ].filter(Boolean);

      const episodeItems = [];
      for (const segment of segments) {
        const item = createNormalizedSegment({ ...common, ...segment });
        if (item) {
          episodeItems.push(item);
          extractedItems.push(item);
        }
      }
      logCapturedTimestamps({
        prefix: 'NFE',
        showTitle: video.title,
        season: season.seq,
        episode: episode.seq,
        episodeTitle: common.episodeTitle,
        providerIdLabel: 'episodeId',
        providerId: episodeId,
        items: episodeItems,
      });
    }
  }
  recordExtractedSegments(extractedItems);
}

function setupNetflixInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OriginalXHR = win.XMLHttpRequest;

  function NetflixInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = requestUrl;
      return originalOpen(method, requestUrl, ...rest);
    };
    xhr.send = function (...args) {
      if (url && url.includes('memberapi') && url.includes('metadata')) {
        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data?.video) processNetflixMetadata(data);
          } catch (_) {}
        });
      }
      return originalSend(...args);
    };
    return xhr;
  }
  Object.setPrototypeOf(NetflixInterceptedXHR, OriginalXHR);
  NetflixInterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = NetflixInterceptedXHR;

  const originalFetch = win.fetch.bind(win);
  win.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const response = await originalFetch(input, init);
    if (url.includes('memberapi') && url.includes('metadata')) {
      try {
        const data = await response.clone().json();
        if (data?.video) processNetflixMetadata(data);
      } catch (_) {}
    }
    return response;
  };
}


  // â”€â”€â”€ providers/netflix/index.js â”€â”€â”€

/** Netflix provider registration. */


bootstrapProvider({
  providerName: 'netflix',
  setupInterception: setupNetflixInterception,
  isPlayerPage: () => location.pathname.startsWith('/watch'),
});

  }

  // Provider registration: prime-video
  if (location.hostname === 'primevideo.com' || location.hostname.endsWith('.primevideo.com') || (/^www\.amazon\./i.test(location.hostname) && location.pathname.startsWith('/gp/video/'))) {

  // â”€â”€â”€ providers/prime-video/extractor.js â”€â”€â”€

/** Prime Video catalogue, playback-resource, and timestamp extraction. */



const PRIME_VIDEO_METADATA_URL_MATCH = 'GetVodPlaybackResources';
const PRIME_VIDEO_ID_PATTERN = /^(?:[A-Z0-9]{9,12}|amzn1\.dv\.gti\.[a-f0-9-]{20,})$/i;
const PRIME_VIDEO_CARD_SELECTOR = '[data-testid="episode-list-item"], li[id^="av-ep-episode-"]';
const PRIME_VIDEO_EPISODE_HEADING_PATTERN = /^\s*(\d+)\s*[.\-:]\s*(.*?)\s*$/;
const PRIME_VIDEO_POLL_INTERVAL_MS = 250;
const PRIME_VIDEO_MAX_POLL_ATTEMPTS = 40;
const PRIME_VIDEO_SELECTION_TTL_MS = 60000;
const PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS = 1000;
const PRIME_VIDEO_SEGMENT_BATCH_DELAY_MS = 500;
const PRIME_VIDEO_SUPPORTED_EVENT_TYPES = new Set(['SKIP_RECAP', 'SKIP_INTRO', 'END_CREDITS', 'NEXT_UP']);

function isPrimeVideoTitleId(value) {
  return typeof value === 'string' && PRIME_VIDEO_ID_PATTERN.test(value);
}

function ensurePrimeVideoState() {
  if (!(state.primeVideoTitleMap instanceof Map)) state.primeVideoTitleMap = new Map();
  if (!(state.primeVideoPendingByTitleId instanceof Map)) state.primeVideoPendingByTitleId = new Map();
  if (!(state.primeVideoDetailMap instanceof Map)) state.primeVideoDetailMap = new Map();
  if (!(state.primeVideoPlaybackTitleByDetailId instanceof Map)) state.primeVideoPlaybackTitleByDetailId = new Map();
  if (!(state.primeVideoCatalogByShowId instanceof Map)) state.primeVideoCatalogByShowId = new Map();
  if (!(state.primeVideoMetadataByTitleId instanceof Map)) state.primeVideoMetadataByTitleId = new Map();
  if (!(state.primeVideoEpisodeTitleByTitleId instanceof Map)) state.primeVideoEpisodeTitleByTitleId = new Map();
  if (!(state.primeVideoFetchedSeasonCatalogUrls instanceof Set)) state.primeVideoFetchedSeasonCatalogUrls = new Set();
  if (!(state.primeVideoPollingTitleIds instanceof Set)) state.primeVideoPollingTitleIds = new Set();
  if (!(state.primeVideoPendingOutroTitleIds instanceof Set)) state.primeVideoPendingOutroTitleIds = new Set();
  if (!(state.primeVideoSegmentBatches instanceof Map)) state.primeVideoSegmentBatches = new Map();
}

function findPrimeVideoTitleIdInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const keys = ['asin', 'ASIN', 'titleId', 'titleID', 'contentId', 'catalogId'];
  for (const key of keys) {
    if (isPrimeVideoTitleId(obj[key])) return obj[key];
  }
  for (const key in obj) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      const found = findPrimeVideoTitleIdInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractPrimeVideoTitleId(bodyText, url) {
  if (url) {
    const titleIdMatch = url.match(/[?&](?:titleId|cGTI)=([^&]+)/i);
    if (titleIdMatch) {
      const titleId = decodeURIComponent(titleIdMatch[1]);
      if (isPrimeVideoTitleId(titleId)) return titleId;
    }
    const legacyIdMatch = url.match(/[?&](?:asin|ASIN)=([A-Z0-9]{9,12})/i);
    if (legacyIdMatch) return legacyIdMatch[1];
  }
  if (!bodyText) return null;
  try {
    const found = findPrimeVideoTitleIdInObject(JSON.parse(bodyText));
    if (found) return found;
  } catch (_) {}

  const patterns = [
    /"(?:asin|titleId|titleID|contentId|catalogId)"\s*:\s*"((?:amzn1\.dv\.gti\.[a-f0-9-]{20,})|(?:[A-Z0-9]{9,12}))"/i,
    /(?:asin|titleId)=((?:amzn1\.dv\.gti\.[a-f0-9-]{20,})|(?:[A-Z0-9]{9,12}))/i,
  ];
  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function coercePrimeVideoInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function findPrimeVideoEpisodeMetadata(root) {
  const candidates = [];
  const visited = new WeakSet();
  const seasonKeys = ['seasonNumber', 'season', 'seasonSequenceNumber', 'seasonSequence'];
  const episodeKeys = ['episodeNumber', 'episode', 'episodeSequenceNumber', 'episodeSequence'];
  const firstInteger = (node, keys) => {
    for (const key of keys) {
      const value = coercePrimeVideoInteger(node?.[key]);
      if (value != null) return value;
    }
    return null;
  };

  function walk(node, depth = 0, path = '') {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      return;
    }

    const season = firstInteger(node, seasonKeys);
    const episode = firstInteger(node, episodeKeys);
    if (season != null && episode != null) {
      const seriesTitle = String(node.seriesTitle || node.showTitle || node.seriesName || node.parentTitle || '').trim();
      const episodeTitle = String(node.episodeTitle || node.title || node.name || '').trim();
      const catalogScore = /catalogMetadata|catalog/i.test(path) ? 4 : 0;
      candidates.push({ season, episode, seriesTitle, episodeTitle, score: catalogScore + (seriesTitle ? 2 : 0) + (episodeTitle ? 1 : 0) });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1, path ? `${path}.${key}` : key);
    }
  }

  walk(root);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function findPrimeVideoEpisodeTitle(root, expectedShowTitle = '') {
  const candidates = [];
  const visited = new WeakSet();
  const normalizedShowTitle = String(expectedShowTitle || '').trim().toLowerCase();

  function walk(node, depth = 0, path = '') {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      return;
    }

    const contentType = String(node.contentType || node.type || node.titleType || '').toUpperCase();
    const episodeContext = contentType === 'EPISODE' ||
      coercePrimeVideoInteger(node.episodeNumber || node.episodeSequenceNumber) != null;
    for (const key of ['episodeTitle', 'displayTitle', 'title', 'name']) {
      const title = typeof node[key] === 'string' ? node[key].trim() : '';
      if (!title || title.length > 300 || title.toLowerCase() === normalizedShowTitle) continue;
      let score = key === 'episodeTitle' ? 20 : 0;
      if (episodeContext) score += 12;
      if (/catalogMetadata\.catalog|episode/i.test(path)) score += 6;
      if (key === 'displayTitle') score += 2;
      candidates.push({ title, score });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1, path ? `${path}.${key}` : key);
    }
  }

  walk(root);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.title || '';
}

function parsePrimeVideoEpisodeText(text) {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const patterns = [
    /\bS\s*(\d+)\s*(?:E|EP|AFL\.?|FOLGE)\s*(\d+)\b/i,
    /\b(?:SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*(\d+)[^\d]{0,30}(?:EPISODE|AFLEVERING|FOLGE|EPISODIO)\s*(\d+)\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const season = coercePrimeVideoInteger(match[1]);
    const episode = coercePrimeVideoInteger(match[2]);
    if (season == null || episode == null) continue;
    const episodeTitle = normalized
      .slice((match.index || 0) + match[0].length)
      .replace(/^\s*[-:|.]\s*/, '')
      .trim();
    return { season, episode, episodeTitle };
  }
  return null;
}

function readPrimeVideoPlayerSnapshot() {
  const player = document.getElementById('dv-web-player');
  const isPlayerActive = !!player && player.offsetWidth > 0 && player.offsetHeight > 0;
  let season = null;
  let episode = null;
  let episodeTitle = '';

  const candidates = [];
  if (player?.querySelectorAll) {
    candidates.push(...player.querySelectorAll(
      '[class*="episode-info" i], [data-testid*="episode" i], [data-automation-id*="episode" i], [aria-label*="episode" i], [aria-label*="aflevering" i]'
    ));
  }
  candidates.push(player);

  for (const node of [...new Set(candidates.filter(Boolean))]) {
    const ariaLabel = node.getAttribute?.('aria-label') || '';
    const text = `${ariaLabel} ${node.textContent || ''}`.trim();
    const parsed = parsePrimeVideoEpisodeText(text);
    if (!parsed) continue;
    season = parsed.season;
    episode = parsed.episode;
    const titleNode = node.querySelector?.('[class*="title" i], [data-testid*="title" i]');
    episodeTitle = String(titleNode?.textContent || parsed.episodeTitle || '').trim();
    break;
  }
  return { isPlayerActive, season, episode, title: document.title, episodeTitle };
}

function updatePrimeVideoTitle(rawTitle) {
  const cleaned = rawTitle.replace(/^Prime Video[:\-]\s*/i, '').trim();
  const seasonMatch = cleaned.match(/\s*(?:-|–)?\s*(?:S|SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*\d+\s*$/i);
  const title = seasonMatch ? cleaned.slice(0, seasonMatch.index).trim() : cleaned;
  handleDetectedShow({ title, showId: title });
  return title;
}

function readPrimeVideoSelectedSeason(root = document) {
  const selector = root.querySelector?.('#av-droplist-av-atf-season-selector');
  const label = selector?.getAttribute?.('aria-label') || selector?.value || '';
  const pageTitle = root.title || '';
  const number = String(label).match(/\d+/)?.[0] ||
    String(pageTitle).match(/(?:^|\s|-)(?:S|SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*(\d+)\b/i)?.[1];
  return coercePrimeVideoInteger(number);
}

function readPrimeVideoSeriesTitle(root = document) {
  const heading = root.querySelector?.('main h1') || root.querySelector?.('h1');
  const text = String(heading?.textContent || '').trim();
  if (text) return text;
  return String(heading?.querySelector?.('img[alt]')?.getAttribute?.('alt') || '').trim();
}

function readPrimeVideoCardTitleId(card) {
  const selector = card.querySelector?.('input[id^="selector-"]');
  const selectorId = selector?.getAttribute?.('id') || selector?.id || '';
  const titleId = selectorId.replace(/^selector-/, '');
  if (isPrimeVideoTitleId(titleId)) return titleId;

  const metadataNode = card.querySelector?.('[data-testid*="amzn1.dv.gti."], [data-automation-id*="amzn1.dv.gti."]');
  if (metadataNode) {
    for (const attribute of ['data-testid', 'data-automation-id']) {
      const value = metadataNode.getAttribute?.(attribute) || '';
      const match = value.match(/amzn1\.dv\.gti\.[a-f0-9-]{20,}/i);
      if (match && isPrimeVideoTitleId(match[0])) return match[0];
    }
  }

  const link = card.querySelector?.('a[href*="cGTI="], a[href*="titleId="]');
  return extractPrimeVideoTitleId('', link?.getAttribute?.('href') || '');
}

function readPrimeVideoCardEpisode(card) {
  const heading = String(card?.querySelector?.('h3')?.textContent || '').trim();
  const match = heading.match(PRIME_VIDEO_EPISODE_HEADING_PATTERN);
  const episode = coercePrimeVideoInteger(match?.[1]);
  return episode == null ? null : { episode, episodeTitle: match?.[2] || '' };
}

function readPrimeVideoDetailId(url) {
  return String(url || '').match(/\/detail\/([A-Z0-9]{10,})/i)?.[1]?.toUpperCase() || null;
}

function readPrimeVideoCardDetailId(card) {
  const directLink = card.querySelector?.('a[href*="/detail/"]');
  const directId = readPrimeVideoDetailId(directLink?.getAttribute?.('href'));
  if (directId) return directId;

  const returnLink = card.querySelector?.('a[href*="return_url="]');
  const href = returnLink?.getAttribute?.('href') || '';
  const encoded = href.match(/[?&]return_url=([^&]+)/i)?.[1];
  if (!encoded || typeof atob !== 'function') return null;
  try {
    const base64 = decodeURIComponent(encoded).replace(/-/g, '+').replace(/_/g, '/');
    return readPrimeVideoDetailId(atob(base64));
  } catch (_) {
    return null;
  }
}

function readCurrentPrimeVideoDetailId() {
  if (typeof location === 'undefined') return null;
  return readPrimeVideoDetailId(location.href || location.pathname);
}

function refreshPrimeVideoEpisodeTitle(showId, season, episode, episodeTitle) {
  if (!episodeTitle) return;
  for (const snapshot of state.primeVideoTitleMap.values()) {
    if (snapshot.showId === showId && snapshot.season === season && snapshot.episode === episode) {
      snapshot.episodeTitle = episodeTitle;
    }
  }
  for (const item of state.allItems) {
    if (item._showId === showId && item.season === season && item.episode === episode) {
      item._episodeTitle = episodeTitle;
    }
  }
  for (const batch of state.primeVideoSegmentBatches.values()) {
    if (batch.showId !== showId || batch.season !== season || batch.episode !== episode) continue;
    batch.episodeTitle = episodeTitle;
    batch.items.forEach(item => { item._episodeTitle = episodeTitle; });
  }
  if (state.primeVideoActiveEpisode?.showId === showId &&
      state.primeVideoActiveEpisode.season === season && state.primeVideoActiveEpisode.episode === episode) {
    state.primeVideoActiveEpisode.episodeTitle = episodeTitle;
  }
}

function settlePrimeVideoPlaybackFallbacks(titleId) {
  const currentDetailId = readCurrentPrimeVideoDetailId();
  if (currentDetailId && state.primeVideoDetailMap.has(currentDetailId) &&
      !state.primeVideoPlaybackTitleByDetailId.has(currentDetailId)) {
    state.primeVideoPlaybackTitleByDetailId.set(currentDetailId, titleId);
  }

  if (state.primeVideoSelectedEpisode && state.primeVideoSelectedEpisode.resolvedTitleId == null) {
    state.primeVideoSelectedEpisode.resolvedTitleId = titleId;
  }
}

function setPrimeVideoActiveEpisode(snapshot) {
  const current = state.primeVideoActiveEpisode;
  if (current?.showId === snapshot.showId) {
    const currentPosition = current.season * 100000 + current.episode;
    const nextPosition = snapshot.season * 100000 + snapshot.episode;
    if (nextPosition < currentPosition) return;
  }
  state.primeVideoActiveEpisode = {
    season: snapshot.season,
    episode: snapshot.episode,
    episodeTitle: snapshot.episodeTitle || '',
    showId: snapshot.showId,
  };
}

function hasPrimeVideoSegmentEvents(data) {
  const events = data?.transitionTimecodes?.result?.events;
  return Array.isArray(events) && events.some(event => PRIME_VIDEO_SUPPORTED_EVENT_TYPES.has(event?.eventType));
}

function inferNextPrimeVideoEpisode() {
  const active = state.primeVideoActiveEpisode;
  if (!active?.showId || active.season == null || active.episode == null) return null;
  const rawPageTitle = readPrimeVideoSeriesTitle(document) || String(document.title || '')
    .replace(/^Prime Video[:\-]\s*/i, '')
    .replace(/\s*(?:-|\u2013)?\s*(?:S|SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*\d+\s*$/i, '')
    .trim();
  if (rawPageTitle && rawPageTitle !== active.showId) return null;

  const seasons = state.primeVideoCatalogByShowId.get(active.showId);
  const currentSeason = seasons?.get(active.season);
  const lastCatalogEpisode = currentSeason?.size ? Math.max(...currentSeason.keys()) : null;
  let season = active.season;
  let episode = active.episode + 1;
  if (lastCatalogEpisode != null && active.episode >= lastCatalogEpisode) {
    season++;
    episode = 1;
  }

  const catalogSnapshot = seasons?.get(season)?.get(episode);
  return {
    season,
    episode,
    episodeTitle: catalogSnapshot?.episodeTitle || '',
    showId: active.showId,
    seriesTitle: active.showId,
  };
}

function rememberPrimeVideoEpisodeSelection(card, root = document) {
  ensurePrimeVideoState();
  const season = readPrimeVideoSelectedSeason(root);
  const seriesTitle = readPrimeVideoSeriesTitle(root);
  const cardEpisode = readPrimeVideoCardEpisode(card);
  if (season == null || !cardEpisode || !seriesTitle) return false;

  const showId = updatePrimeVideoTitle(seriesTitle);
  state.primeVideoSelectedEpisode = {
    season,
    ...cardEpisode,
    showId,
    seriesTitle,
    selectedAt: Date.now(),
  };
  return true;
}

/**
 * Prime's current detail page exposes stable episode GTIs before playback.
 * Cache them up front because the player overlay no longer reliably renders
 * the old atvwebplayersdk episode-info element.
 */
function scanPrimeVideoEpisodeCatalog(root = document) {
  ensurePrimeVideoState();
  const season = readPrimeVideoSelectedSeason(root);
  const seriesTitle = readPrimeVideoSeriesTitle(root);
  if (season == null || !seriesTitle) return 0;

  const showId = updatePrimeVideoTitle(seriesTitle);
  const cards = root.querySelectorAll?.(PRIME_VIDEO_CARD_SELECTOR) || [];
  let seasons = state.primeVideoCatalogByShowId.get(showId);
  if (!seasons) {
    seasons = new Map();
    state.primeVideoCatalogByShowId.set(showId, seasons);
  }
  let seasonCatalog = seasons.get(season);
  if (!seasonCatalog) {
    seasonCatalog = new Map();
    seasons.set(season, seasonCatalog);
  }
  const seen = new Set();
  let found = 0;

  for (const card of cards) {
    const cardEpisode = readPrimeVideoCardEpisode(card);
    const titleId = readPrimeVideoCardTitleId(card);
    if (!cardEpisode || !titleId || seen.has(titleId)) continue;
    seen.add(titleId);

    const snapshot = { season, ...cardEpisode, showId };
    const collision = findPrimeVideoEpisodeCollision(titleId, showId, season, cardEpisode.episode);
    state.primeVideoTitleMap.set(titleId, snapshot);
    seasonCatalog.set(cardEpisode.episode, snapshot);
    refreshPrimeVideoEpisodeTitle(showId, season, cardEpisode.episode, cardEpisode.episodeTitle);
    const detailId = readPrimeVideoCardDetailId(card);
    if (detailId) state.primeVideoDetailMap.set(detailId, { ...snapshot, seriesTitle });
    if (!collision) {
      recordProviderEpisode({ providerId: titleId, season, episode: cardEpisode.episode, title: cardEpisode.episodeTitle }, showId);
    }
    found++;
  }
  return found;
}

async function preloadPrimeVideoSeasonCatalogs(root = document, options = {}) {
  ensurePrimeVideoState();
  const baseUrl = root.location?.href || (typeof location !== 'undefined' ? location.href : '');
  if (!baseUrl) return 0;
  const currentDetailId = readPrimeVideoDetailId(baseUrl);
  const links = root.querySelectorAll?.('a[href*="atv_dp_season_select_s"]') || [];
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const parseHtml = options.parseHtml || (html => new DOMParser().parseFromString(html, 'text/html'));
  let total = 0;

  await Promise.all([...links].map(async link => {
    const href = link.getAttribute?.('href') || '';
    if (!href) return;
    let url;
    try {
      url = new URL(href, baseUrl);
      if (url.origin !== new URL(baseUrl).origin) return;
    } catch (_) {
      return;
    }

    const urlKey = url.href;
    if (state.primeVideoFetchedSeasonCatalogUrls.has(urlKey)) return;
    state.primeVideoFetchedSeasonCatalogUrls.add(urlKey);
    if (readPrimeVideoDetailId(urlKey) === currentDetailId) return;

    try {
      const response = await fetchImpl(urlKey, { credentials: 'same-origin' });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
      const seasonDocument = parseHtml(await response.text());
      const found = scanPrimeVideoEpisodeCatalog(seasonDocument);
      total += found;
      if (found) {
        console.info('[PVE] Preloaded Prime Video season catalogue:', {
          url: urlKey,
          episodes: found,
        });
      }
    } catch (error) {
      state.primeVideoFetchedSeasonCatalogUrls.delete(urlKey);
      console.warn('[PVE] Could not preload season catalogue:', urlKey, error);
    }
  }));
  return total;
}

function findPrimeVideoEpisodeCollision(titleId, showId, season, episode) {
  for (const [knownTitleId, known] of state.primeVideoTitleMap) {
    if (knownTitleId !== titleId && known.showId === showId && known.season === season && known.episode === episode) return known;
  }
  return null;
}

function coercePrimeVideoMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readPrimeVideoEventTimeMs(event, boundary) {
  const keys = boundary === 'start'
    ? ['startTimeMs', 'startTimecodeMs', 'startTimeCodeMs', 'startMs']
    : ['endTimeMs', 'endTimecodeMs', 'endTimeCodeMs', 'endMs'];
  for (const key of keys) {
    const value = coercePrimeVideoMilliseconds(event?.[key]);
    if (value != null) return value;
  }
  return null;
}

function findPrimeVideoRuntimeMs(root, events = []) {
  const candidates = events
    .map(event => readPrimeVideoEventTimeMs(event, 'end'))
    .filter(value => value != null);
  const visited = new WeakSet();
  const millisecondKeys = new Set(['runtimems', 'runtimemillis', 'runtimemilliseconds', 'durationms', 'durationmillis', 'durationmilliseconds']);
  const secondKeys = new Set(['runtimeseconds', 'runtimeinseconds', 'durationseconds', 'durationinseconds']);

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        if (millisecondKeys.has(normalizedKey)) candidates.push(number);
        if (secondKeys.has(normalizedKey)) candidates.push(number * 1000);
      } else if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  }

  walk(root);
  return candidates.length ? Math.max(...candidates) : null;
}

function parsePrimeVideoClockSeconds(value) {
  const parts = String(value || '').split(':').map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function readPrimeVideoMediaDurationMs() {
  const candidates = [];
  const videos = document.querySelectorAll?.('#dv-web-player video, [id^="dv-web-player"] video, video') || [];
  for (const video of videos) {
    const durationSeconds = Number(video?.duration);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) candidates.push(durationSeconds);
    try {
      const seekableEnd = video.seekable?.length ? Number(video.seekable.end(video.seekable.length - 1)) : null;
      if (Number.isFinite(seekableEnd) && seekableEnd > 0) candidates.push(seekableEnd);
    } catch (_) {}
  }

  const timeIndicators = document.querySelectorAll?.(
    '#dv-web-player .atvwebplayersdk-timeindicator-text, [id^="dv-web-player"] .atvwebplayersdk-timeindicator-text'
  ) || [];
  for (const indicator of timeIndicators) {
    const text = `${indicator.getAttribute?.('aria-label') || ''} ${indicator.textContent || ''}`;
    const clocks = text.match(/(?:\d{1,2}:)?\d{1,2}:\d{2}/g) || [];
    if (clocks.length < 2) continue;
    const elapsedSeconds = parsePrimeVideoClockSeconds(clocks[0]);
    const remainingSeconds = parsePrimeVideoClockSeconds(clocks[1]);
    if (elapsedSeconds != null && remainingSeconds != null) candidates.push(elapsedSeconds + remainingSeconds);
  }

  return candidates.length ? Math.max(...candidates) * 1000 : null;
}

function logPrimeVideoTimestamps(titleId, showId, season, episode, episodeTitle, items) {
  logCapturedTimestamps({
    prefix: 'PVE',
    showTitle: showId,
    season,
    episode,
    episodeTitle,
    providerIdLabel: 'titleId',
    providerId: titleId,
    items,
  });
}

function flushPrimeVideoSegmentBatch(titleId) {
  const batch = state.primeVideoSegmentBatches.get(titleId);
  if (!batch) return;
  state.primeVideoSegmentBatches.delete(titleId);
  const items = batch.items.filter(item => !state.allItems.some(existing => existing._eid === item._eid));
  logPrimeVideoTimestamps(titleId, batch.showId, batch.season, batch.episode, batch.episodeTitle, items);
  recordExtractedSegments(items);
}

function queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, items, { waitForOutro = false, outroResolved = false } = {}) {
  let batch = state.primeVideoSegmentBatches.get(titleId);
  if (!batch) {
    batch = { titleId, showId, season, episode, episodeTitle, items: [], timer: null, waitingForOutro: false };
    state.primeVideoSegmentBatches.set(titleId, batch);
  }
  for (const item of items) {
    if (!batch.items.some(existing => existing._eid === item._eid)) batch.items.push(item);
  }
  if (waitForOutro) batch.waitingForOutro = true;
  if (outroResolved) batch.waitingForOutro = false;
  if (batch.waitingForOutro || !batch.items.length) return;

  if (batch.timer != null && typeof clearTimeout === 'function') clearTimeout(batch.timer);
  if (typeof window === 'undefined') {
    flushPrimeVideoSegmentBatch(titleId);
    return;
  }
  batch.timer = setTimeout(() => flushPrimeVideoSegmentBatch(titleId), PRIME_VIDEO_SEGMENT_BATCH_DELAY_MS);
}

function appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, segmentType, startTimeMs, endTimeMs) {
  const episodeId = `${titleId}_${segmentType}`;
  const alreadyCaptured = item => item._eid === episodeId || (
    item._showId === showId &&
    item.season === season &&
    item.episode === episode &&
    item.segment_type === segmentType
  );
  if (state.allItems.some(alreadyCaptured) || extractedItems.some(alreadyCaptured)) return false;
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: episodeTitle,
    _showId: showId,
    imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
    segment_type: segmentType,
    season,
    episode,
    start_sec: startTimeMs / 1000,
    end_sec: endTimeMs / 1000,
  });
  return true;
}

function pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs, attempt = 0) {
  const endTimeMs = readPrimeVideoMediaDurationMs();
  if (endTimeMs != null && endTimeMs > startTimeMs) {
    const extractedItems = [];
    appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, 'outro', startTimeMs, endTimeMs);
    state.primeVideoPendingOutroTitleIds.delete(titleId);
    queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, extractedItems, { outroResolved: true });
    return;
  }
  if (attempt >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) {
    state.primeVideoPendingOutroTitleIds.delete(titleId);
    console.warn('[PVE] NEXT_UP had a start time, but no episode duration could be resolved:', titleId);
    queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, [], { outroResolved: true });
    return;
  }
  setTimeout(
    () => pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs, attempt + 1),
    PRIME_VIDEO_POLL_INTERVAL_MS
  );
}

function finalizePrimeVideoEvents(titleId, season, episode, data, episodeTitle = '', showId = state.showId) {
  const events = data?.transitionTimecodes?.result?.events || [];
  const extractedItems = [];
  const runtimeMs = findPrimeVideoRuntimeMs(data, events) ?? readPrimeVideoMediaDurationMs();
  const resolveEventRange = (event, useRuntime = false) => {
    const startTimeMs = readPrimeVideoEventTimeMs(event, 'start');
    let endTimeMs = readPrimeVideoEventTimeMs(event, 'end');
    if (useRuntime && (endTimeMs == null || endTimeMs <= startTimeMs)) endTimeMs = runtimeMs;
    return startTimeMs != null && endTimeMs != null && endTimeMs > startTimeMs
      ? { event, startTimeMs, endTimeMs }
      : null;
  };
  const outroCandidates = events.filter(event => event.eventType === 'END_CREDITS' || event.eventType === 'NEXT_UP');
  const outroRange = outroCandidates
    .filter(event => event.eventType === 'END_CREDITS')
    .map(event => resolveEventRange(event, true))
    .find(Boolean) || outroCandidates
    .filter(event => event.eventType === 'NEXT_UP')
    .map(event => resolveEventRange(event, true))
    .find(Boolean);

  for (const event of events) {
    let segmentType = null;
    if (event.eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (event.eventType === 'SKIP_INTRO') segmentType = 'intro';
    const range = event === outroRange?.event ? outroRange : resolveEventRange(event);
    if (event === outroRange?.event) segmentType = 'outro';
    if (!segmentType || !range) continue;
    appendPrimeVideoSegment(
      extractedItems,
      titleId,
      showId,
      season,
      episode,
      episodeTitle,
      segmentType,
      range.startTimeMs,
      range.endTimeMs
    );
  }

  if (!outroRange && outroCandidates.length) {
    const startTimeMs = outroCandidates
      .map(event => readPrimeVideoEventTimeMs(event, 'start'))
      .find(value => value != null);
    if (startTimeMs != null && !state.primeVideoPendingOutroTitleIds.has(titleId)) {
      state.primeVideoPendingOutroTitleIds.add(titleId);
      queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, extractedItems, { waitForOutro: true });
      pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs);
      return;
    } else if (startTimeMs == null) {
      console.warn('[PVE] Prime returned an outro event without a usable start time:', outroCandidates);
    }
  }
  queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, extractedItems);
}

function commitPrimeVideoEpisode(titleId, snapshot, { allowNumberReuse = false } = {}) {
  const showId = updatePrimeVideoTitle(snapshot.seriesTitle || snapshot.title);
  const collision = findPrimeVideoEpisodeCollision(titleId, showId, snapshot.season, snapshot.episode);
  if (collision && !allowNumberReuse) return false;

  const episodeTitle = snapshot.episodeTitle || '';
  const resolvedSnapshot = { season: snapshot.season, episode: snapshot.episode, episodeTitle, showId };
  state.primeVideoTitleMap.set(titleId, resolvedSnapshot);
  setPrimeVideoActiveEpisode(resolvedSnapshot);
  settlePrimeVideoPlaybackFallbacks(titleId);
  state.primeVideoPollingTitleIds.delete(titleId);
  if (!collision) {
    recordProviderEpisode({ providerId: titleId, season: snapshot.season, episode: snapshot.episode, title: episodeTitle }, showId);
  }
  const pending = state.primeVideoPendingByTitleId.get(titleId) || [];
  state.primeVideoPendingByTitleId.delete(titleId);
  pending.forEach(data => finalizePrimeVideoEvents(titleId, snapshot.season, snapshot.episode, data, episodeTitle, showId));
  return true;
}

function pollPrimeVideoEpisode(titleId, attempt) {
  const snapshot = readPrimeVideoPlayerSnapshot();
  if (snapshot.isPlayerActive && snapshot.season != null && snapshot.episode != null) {
    if (commitPrimeVideoEpisode(titleId, snapshot)) return;
  }
  if (attempt >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) {
    console.warn('[PVE] Could not resolve season/episode for title ID:', titleId);
    state.primeVideoPendingByTitleId.delete(titleId);
    state.primeVideoPollingTitleIds.delete(titleId);
    return;
  }
  setTimeout(() => pollPrimeVideoEpisode(titleId, attempt + 1), PRIME_VIDEO_POLL_INTERVAL_MS);
}

function processPrimeVideoMetadata(data, bodyText, url) {
  ensurePrimeVideoState();
  const titleId = extractPrimeVideoTitleId(bodyText, url);
  if (!titleId) return;
  const responseMetadata = findPrimeVideoEpisodeMetadata(data);
  const expectedShowTitle = responseMetadata?.seriesTitle || state.showId || readPrimeVideoSeriesTitle(document);
  const responseEpisodeTitle = responseMetadata?.episodeTitle || findPrimeVideoEpisodeTitle(data, expectedShowTitle);
  if (responseMetadata) {
    state.primeVideoMetadataByTitleId.set(titleId, { ...responseMetadata, episodeTitle: responseEpisodeTitle });
  }
  if (responseEpisodeTitle) {
    state.primeVideoEpisodeTitleByTitleId.set(titleId, responseEpisodeTitle);
    const mapped = state.primeVideoTitleMap.get(titleId);
    if (mapped) {
      refreshPrimeVideoEpisodeTitle(mapped.showId, mapped.season, mapped.episode, responseEpisodeTitle);
      recordProviderEpisode({
        providerId: titleId,
        season: mapped.season,
        episode: mapped.episode,
        title: responseEpisodeTitle,
      }, mapped.showId);
    }
  }
  if (!hasPrimeVideoSegmentEvents(data)) return;
  if (state.primeVideoTitleMap.has(titleId)) {
    const { season, episode, episodeTitle, showId } = state.primeVideoTitleMap.get(titleId);
    setPrimeVideoActiveEpisode({ season, episode, episodeTitle, showId });
    settlePrimeVideoPlaybackFallbacks(titleId);
    finalizePrimeVideoEvents(titleId, season, episode, data, episodeTitle, showId);
    return;
  }
  if (!state.primeVideoPendingByTitleId.has(titleId)) state.primeVideoPendingByTitleId.set(titleId, []);
  state.primeVideoPendingByTitleId.get(titleId).push(data);
  const metadata = responseMetadata || state.primeVideoMetadataByTitleId.get(titleId);
  if (metadata) {
    commitPrimeVideoEpisode(titleId, {
      ...metadata,
      episodeTitle: metadata.episodeTitle || state.primeVideoEpisodeTitleByTitleId.get(titleId) || '',
      title: metadata.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const currentDetailId = readCurrentPrimeVideoDetailId();
  const detailSnapshot = currentDetailId && state.primeVideoDetailMap.get(currentDetailId);
  const detailPlaybackTitleId = currentDetailId && state.primeVideoPlaybackTitleByDetailId.get(currentDetailId);
  if (detailSnapshot && (!detailPlaybackTitleId || detailPlaybackTitleId === titleId)) {
    commitPrimeVideoEpisode(titleId, {
      ...detailSnapshot,
      title: detailSnapshot.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const selectedSnapshot = state.primeVideoSelectedEpisode;
  const selectionIsCurrent = selectedSnapshot && selectedSnapshot.resolvedTitleId == null &&
    Date.now() - selectedSnapshot.selectedAt < PRIME_VIDEO_SELECTION_TTL_MS;
  if (selectionIsCurrent) {
    commitPrimeVideoEpisode(titleId, {
      ...selectedSnapshot,
      title: selectedSnapshot.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const inferredSnapshot = inferNextPrimeVideoEpisode();
  if (inferredSnapshot) {
    inferredSnapshot.episodeTitle ||= state.primeVideoEpisodeTitleByTitleId.get(titleId) || '';
    console.info('[PVE] Inferred next episode from the scanned season boundary:', {
      titleId,
      season: inferredSnapshot.season,
      episode: inferredSnapshot.episode,
    });
    commitPrimeVideoEpisode(titleId, inferredSnapshot, { allowNumberReuse: true });
    return;
  }
  if (!state.primeVideoPollingTitleIds.has(titleId)) {
    state.primeVideoPollingTitleIds.add(titleId);
    pollPrimeVideoEpisode(titleId, 0);
  }
}

function setupPrimeVideoInterception() {
  ensurePrimeVideoState();
  const scanCatalog = () => {
    try {
      scanPrimeVideoEpisodeCatalog();
      preloadPrimeVideoSeasonCatalogs();
    }
    catch (error) { console.warn('[PVE] Failed to scan episode catalogue:', error); }
  };
  scanCatalog();
  setInterval(scanCatalog, PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS);
  if (typeof MutationObserver === 'function') {
    let scanTimer = null;
    const observer = new MutationObserver(() => {
      if (scanTimer != null) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanCatalog, PRIME_VIDEO_POLL_INTERVAL_MS);
    });
    observer.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label'],
    });
  }
  document.addEventListener('click', event => {
    const card = event.target?.closest?.(PRIME_VIDEO_CARD_SELECTOR);
    if (card) rememberPrimeVideoEpisodeSelection(card);
  }, true);
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OriginalXHR = win.XMLHttpRequest;

  function PrimeVideoInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    let bodyText = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = String(requestUrl || '');
      return originalOpen(method, requestUrl, ...rest);
    };
    xhr.send = function (body, ...rest) {
      bodyText = typeof body === 'string' ? body : '';
      if (url && url.includes(PRIME_VIDEO_METADATA_URL_MATCH)) {
        xhr.addEventListener('load', () => {
          try { processPrimeVideoMetadata(JSON.parse(xhr.responseText), bodyText, url); }
          catch (error) { console.error('[PVE] Failed to process XHR response:', error); }
        });
      }
      return originalSend(body, ...rest);
    };
    return xhr;
  }
  Object.setPrototypeOf(PrimeVideoInterceptedXHR, OriginalXHR);
  PrimeVideoInterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = PrimeVideoInterceptedXHR;

  const originalFetch = win.fetch.bind(win);
  win.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ? String(input.url) : String(input || ''));
    let bodyText = '';
    if (url.includes(PRIME_VIDEO_METADATA_URL_MATCH)) {
      try {
        if (init && typeof init.body === 'string') bodyText = init.body;
        else if (input && typeof input === 'object' && input.clone) bodyText = await input.clone().text().catch(() => '');
      } catch (_) {}
    }
    const response = await originalFetch(input, init);
    if (url.includes(PRIME_VIDEO_METADATA_URL_MATCH)) {
      try { processPrimeVideoMetadata(await response.clone().json(), bodyText, url); }
      catch (error) { console.error('[PVE] Failed to process fetch response:', error); }
    }
    return response;
  };
}


  // â”€â”€â”€ providers/prime-video/index.js â”€â”€â”€

/** Prime Video provider registration. */


bootstrapProvider({
  providerName: 'prime-video',
  setupInterception: setupPrimeVideoInterception,
});

  }

  // Provider registration: apple-tv
  if (location.hostname === 'tv.apple.com') {

  // â”€â”€â”€ providers/apple-tv/extractor.js â”€â”€â”€

/** Apple TV catalogue, HLS metadata, and timestamp extraction. */



const APPLE_TV_ID_PATTERN = /^umc\.cmc\.[a-z0-9]+$/i;
const APPLE_TV_CATALOG_PAGE_SIZE = 50;
const APPLE_TV_MAX_CATALOG_PAGES = 100;
const APPLE_TV_SERIALIZED_DATA_ID = 'serialized-server-data';
const APPLE_TV_HLS_PREFIX = 'com.apple.hls.';

let appleTvNativeFetch = null;
let appleTvUtsSession = null;
let appleTvCatalogRequestInFlight = false;
let appleTvPendingShowId = null;

function ensureAppleTvState() {
  if (!(state.appleTvEpisodesByCanonicalId instanceof Map)) state.appleTvEpisodesByCanonicalId = new Map();
  if (!(state.appleTvEpisodesByPlayableId instanceof Map)) state.appleTvEpisodesByPlayableId = new Map();
  if (!(state.appleTvEpisodesByManifestUrl instanceof Map)) state.appleTvEpisodesByManifestUrl = new Map();
  if (!(state.appleTvManifestRequests instanceof Set)) state.appleTvManifestRequests = new Set();
  if (!(state.appleTvCatalogShowIds instanceof Set)) state.appleTvCatalogShowIds = new Set();
}

function coerceAppleTvInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function coerceAppleTvSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readAppleTvShowId(url = typeof location === 'undefined' ? '' : location.href) {
  const raw = String(url || '');
  const match = raw.match(/\/show\/[^/?#]+\/(umc\.cmc\.[a-z0-9]+)/i);
  if (match?.[1]) return match[1];
  try {
    const queryShowId = new URL(raw, 'https://tv.apple.com/').searchParams.get('showId');
    return APPLE_TV_ID_PATTERN.test(String(queryShowId || '')) ? queryShowId : null;
  } catch (_) {
    return null;
  }
}

function readAppleTvEpisodeId(url = typeof location === 'undefined' ? '' : location.href) {
  const match = String(url || '').match(/\/episode\/[^/?#]+\/(umc\.cmc\.[a-z0-9]+)/i);
  return match?.[1] || null;
}

function readAppleTvPageTitle(root = document) {
  const heading = root.querySelector?.('[data-testid="product-header"] h1, main h1, h1');
  const headingText = String(heading?.textContent || '').trim();
  if (headingText) return headingText;
  return String(root.title || '')
    .replace(/^Apple TV\s*[+:\-]\s*/i, '')
    .replace(/\s*[|\-]\s*Apple TV.*$/i, '')
    .trim();
}

function updateAppleTvShow(title, showId) {
  const normalizedTitle = String(title || '').trim();
  const normalizedShowId = String(showId || '').trim();
  if (!normalizedTitle || !APPLE_TV_ID_PATTERN.test(normalizedShowId)) return false;
  if (state.showTitle === normalizedTitle && state.showId === normalizedShowId) return true;
  handleDetectedShow({ title: normalizedTitle, showId: normalizedShowId });
  return true;
}

function normalizeAppleTvManifestUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, typeof location === 'undefined' ? 'https://tv.apple.com/' : location.href);
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return raw;
  }
}

function normalizeAppleTvLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyAppleTvSkipLabel(label) {
  const normalized = normalizeAppleTvLabel(label);
  if (!normalized) return null;
  if (/(?:recap|recapitul|samenvatt|previously|previous episode|vorige aflevering|ruckblick|resumen|riassunto|anterior|precedemment)/i.test(normalized)) {
    return 'recap';
  }
  if (/(?:intro|opening|begintitel|opening credits|vorspann|apertura|cabecera|generique)/i.test(normalized)) {
    return 'intro';
  }
  return null;
}

function parseAppleTvHlsAttributes(line) {
  const attributes = {};
  const source = String(line || '').replace(/^#EXT-X-SESSION-DATA:?/i, '');
  const pattern = /(?:^|,)\s*([A-Z0-9-]+)=(?:"((?:\\.|[^"])*)"|([^,]*))/gi;
  let match;
  while ((match = pattern.exec(source))) {
    attributes[match[1].toUpperCase()] = String(match[2] ?? match[3] ?? '')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return attributes;
}

function parseAppleTvHlsMetadata(manifestText) {
  const metadata = {};
  for (const line of String(manifestText || '').split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-SESSION-DATA')) continue;
    const attributes = parseAppleTvHlsAttributes(line);
    let key = attributes['DATA-ID'];
    const value = attributes.VALUE;
    if (!key || value == null) continue;
    if (key.startsWith(APPLE_TV_HLS_PREFIX)) key = key.slice(APPLE_TV_HLS_PREFIX.length);
    metadata[key] = value;
  }
  return metadata;
}

function extractAppleTvMarkers(manifestText, durationSeconds = null) {
  const metadata = parseAppleTvHlsMetadata(manifestText);
  const markerCount = Number.parseInt(metadata['skip.count'], 10);
  const rawSkipMarkers = [];

  if (Number.isInteger(markerCount) && markerCount > 0) {
    for (let index = 0; index < markerCount; index++) {
      const prefix = `skip.${index}`;
      const start = coerceAppleTvSeconds(metadata[`${prefix}.start`]);
      const end = coerceAppleTvSeconds(metadata[`${prefix}.target`]);
      const label = String(metadata[`${prefix}.label`] || '').trim();
      const isPromo = metadata[`${prefix}.promo.enabled`] === 'true';
      if (start == null || end == null || end <= start || isPromo) continue;
      rawSkipMarkers.push({ index, start, end, label, type: classifyAppleTvSkipLabel(label) });
    }
  }

  const unresolved = rawSkipMarkers.filter(marker => !marker.type);
  if (unresolved.length === 1 && unresolved[0].end <= 10 * 60) unresolved[0].type = 'intro';
  if (unresolved.length > 1) {
    unresolved.forEach((marker, index) => {
      marker.type = index === 0 ? 'recap' : 'intro';
    });
  }

  const segments = rawSkipMarkers
    .filter(marker => marker.type)
    .map(marker => ({ type: marker.type, start: marker.start, end: marker.end, label: marker.label }));

  const outroStart = coerceAppleTvSeconds(metadata['up-next.start']);
  const durationCandidates = [
    coerceAppleTvSeconds(durationSeconds),
    coerceAppleTvSeconds(metadata['watched.time']),
  ].filter(value => value != null && (outroStart == null || value > outroStart));
  const outroEnd = durationCandidates.length ? Math.max(...durationCandidates) : null;
  if (outroStart != null && outroEnd != null && outroEnd > outroStart) {
    segments.push({ type: 'outro', start: outroStart, end: outroEnd, label: 'up-next' });
  }

  const seen = new Set();
  return segments.filter(segment => {
    if (seen.has(segment.type)) return false;
    seen.add(segment.type);
    return true;
  });
}

function logAppleTvTimestamps(episode, items) {
  logCapturedTimestamps({
    prefix: 'ATVE',
    showTitle: episode.showTitle || state.showTitle,
    season: episode.season,
    episode: episode.episode,
    episodeTitle: episode.episodeTitle,
    providerIdLabel: 'canonicalId',
    providerId: episode.canonicalId,
    items,
  });
}

function rememberAppleTvEpisode(episode) {
  ensureAppleTvState();
  const canonicalId = String(episode?.canonicalId || '').trim();
  const season = coerceAppleTvInteger(episode?.season);
  const episodeNumber = coerceAppleTvInteger(episode?.episode);
  const showId = String(episode?.showId || state.showId || '').trim();
  if (!APPLE_TV_ID_PATTERN.test(canonicalId) || season == null || episodeNumber == null) return null;

  const normalized = {
    canonicalId,
    playableId: String(episode.playableId || '').trim(),
    showId,
    showTitle: String(episode.showTitle || state.showTitle || '').trim(),
    season,
    episode: episodeNumber,
    episodeTitle: String(episode.episodeTitle || '').trim(),
    duration: coerceAppleTvSeconds(episode.duration),
  };
  state.appleTvEpisodesByCanonicalId.set(canonicalId, normalized);
  if (normalized.playableId) state.appleTvEpisodesByPlayableId.set(normalized.playableId, normalized);
  if (normalized.showTitle && normalized.showId) updateAppleTvShow(normalized.showTitle, normalized.showId);
  recordProviderEpisode({
    providerId: canonicalId,
    season,
    episode: episodeNumber,
    title: normalized.episodeTitle,
  }, showId);
  return normalized;
}

function resolveAppleTvEpisode(root, playable, showId) {
  const canonicalId = String(playable?.canonicalId || root?.id || '').trim();
  const canonical = playable?.canonicalMetadata || {};
  return rememberAppleTvEpisode({
    canonicalId,
    playableId: playable?.id,
    showId,
    showTitle: canonical.showTitle,
    season: root?.seasonNumber ?? canonical.seasonNumber,
    episode: root?.episodeNumber ?? canonical.episodeNumber,
    episodeTitle: root?.title ?? canonical.episodeTitle ?? playable?.title,
    duration: playable?.duration ?? root?.duration ?? canonical.duration,
  });
}

function findAppleTvEpisodeForManifest(url) {
  ensureAppleTvState();
  const normalizedUrl = normalizeAppleTvManifestUrl(url);
  const exact = state.appleTvEpisodesByManifestUrl.get(normalizedUrl);
  if (exact) return exact;
  const currentEpisodeId = readAppleTvEpisodeId();
  if (currentEpisodeId && state.appleTvEpisodesByCanonicalId.has(currentEpisodeId)) {
    return state.appleTvEpisodesByCanonicalId.get(currentEpisodeId);
  }
  return state.appleTvLastPlaybackEpisode || null;
}

function processAppleTvHlsManifest(manifestText, url = '', explicitEpisode = null, playable = null) {
  ensureAppleTvState();
  if (!String(manifestText || '').includes('#EXT-X-SESSION-DATA')) return 0;
  const episode = explicitEpisode || findAppleTvEpisodeForManifest(url);
  if (!episode) return 0;
  const duration = playable?.duration ?? episode.duration;
  const markers = extractAppleTvMarkers(manifestText, duration);
  const items = [];

  for (const marker of markers) {
    const episodeId = `${episode.canonicalId}_${marker.type}`;
    const alreadyCaptured = item => item._eid === episodeId || (
      item._showId === episode.showId &&
      item.season === episode.season &&
      item.episode === episode.episode &&
      item.segment_type === marker.type
    );
    if (state.allItems.some(alreadyCaptured) || items.some(alreadyCaptured)) continue;
    items.push({
      _eid: episodeId,
      _episodeTitle: episode.episodeTitle,
      _showId: episode.showId,
      imdb_id: state.imdbIdsByShowId?.[episode.showId] || 'IMDB_PENDING',
      segment_type: marker.type,
      season: episode.season,
      episode: episode.episode,
      start_sec: marker.start,
      end_sec: marker.end,
    });
  }

  logAppleTvTimestamps(episode, items);
  recordExtractedSegments(items);
  return items.length;
}

function queueAppleTvManifest(url, episode, playable) {
  ensureAppleTvState();
  const normalizedUrl = normalizeAppleTvManifestUrl(url);
  if (!normalizedUrl || state.appleTvManifestRequests.has(normalizedUrl)) return false;
  state.appleTvManifestRequests.add(normalizedUrl);
  state.appleTvEpisodesByManifestUrl.set(normalizedUrl, episode);
  if (!appleTvNativeFetch) return false;

  appleTvNativeFetch(normalizedUrl, { credentials: 'include' })
    .then(response => response.text())
    .then(text => processAppleTvHlsManifest(text, normalizedUrl, episode, playable))
    .catch(error => {
      console.warn('[ATVE] Series-wide manifest fetch failed; waiting for per-episode playback:', episode.canonicalId, error);
    });
  return true;
}

function ingestAppleTvPlayable(playable, episodeRoot = null, showId = state.showId) {
  if (!playable || typeof playable !== 'object') return null;
  const episode = resolveAppleTvEpisode(episodeRoot, playable, showId);
  if (!episode) return null;
  const manifestUrl = playable.assets?.hlsUrl || playable.hlsUrl || '';
  if (manifestUrl) {
    state.appleTvLastPlaybackEpisode = episode;
    queueAppleTvManifest(manifestUrl, episode, playable);
  }
  return episode;
}

function findAppleTvCatalogNodes(root) {
  const found = [];
  const visited = new WeakSet();
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 9 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node.episodes) && node.playables && typeof node.playables === 'object') found.push(node);
    if (Array.isArray(node)) {
      node.forEach(value => walk(value, depth + 1));
      return;
    }
    Object.values(node).forEach(value => walk(value, depth + 1));
  }
  walk(root);
  return found;
}

function processAppleTvCatalogNode(catalog, showId) {
  const playables = catalog.playables || {};
  const episodePlayableMap = catalog.episodesPlayables || {};
  let manifestCount = 0;

  for (const episodeRoot of catalog.episodes || []) {
    const playableId = episodePlayableMap[episodeRoot.id]?.playableId || episodePlayableMap[episodeRoot.id]?.[0]?.playableId;
    const playable = playables[playableId] || Object.values(playables).find(item => item?.canonicalId === episodeRoot.id) || {};
    const episode = ingestAppleTvPlayable({ ...playable, canonicalId: playable.canonicalId || episodeRoot.id }, episodeRoot, showId);
    if (episode && (playable.assets?.hlsUrl || playable.hlsUrl)) manifestCount++;
  }
  return { episodeCount: catalog.episodes?.length || 0, manifestCount };
}

function scanAppleTvPlayableObjects(root, showId) {
  const visited = new WeakSet();
  let manifestCount = 0;
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 10 || visited.has(node)) return;
    visited.add(node);
    if (APPLE_TV_ID_PATTERN.test(String(node.canonicalId || '')) && (node.assets?.hlsUrl || node.hlsUrl)) {
      if (ingestAppleTvPlayable(node, null, showId)) manifestCount++;
    }
    if (Array.isArray(node)) {
      node.forEach(value => walk(value, depth + 1));
      return;
    }
    Object.values(node).forEach(value => walk(value, depth + 1));
  }
  walk(root);
  return manifestCount;
}

function processAppleTvMetadata(payload, url = '', explicitShowId = null) {
  ensureAppleTvState();
  if (!payload || typeof payload !== 'object') return { episodeCount: 0, manifestCount: 0 };
  const root = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const showId = explicitShowId || readAppleTvShowId(url) || readAppleTvShowId() || state.showId;
  let episodeCount = 0;
  let manifestCount = 0;
  const catalogs = findAppleTvCatalogNodes(root);
  for (const catalog of catalogs) {
    const result = processAppleTvCatalogNode(catalog, showId);
    episodeCount += result.episodeCount;
    manifestCount += result.manifestCount;
  }
  if (!catalogs.length) manifestCount += scanAppleTvPlayableObjects(root, showId);
  return { episodeCount, manifestCount };
}

function getAppleTvUtsConfigurationEntry(root) {
  const entries = Array.isArray(root?.data) ? root.data : [];
  return entries.find(entry => entry?.intent?.$kind === 'UtsConfigureIntent')?.data || null;
}

function maybeStartAppleTvSeriesCapture() {
  const showId = state.showId || appleTvPendingShowId;
  if (!appleTvUtsSession || !showId || !appleTvNativeFetch || appleTvCatalogRequestInFlight) return;
  if (state.appleTvCatalogShowIds.has(showId)) return;
  appleTvCatalogRequestInFlight = true;
  fetchAppleTvSeriesCatalog(showId)
    .catch(error => console.warn('[ATVE] Series-wide fetch failed; falling back to per-episode playback:', error))
    .finally(() => { appleTvCatalogRequestInFlight = false; });
}

function processAppleTvSerializedServerData(serialized) {
  ensureAppleTvState();
  let root = serialized;
  if (typeof serialized === 'string') {
    try { root = JSON.parse(serialized); }
    catch (_) { return false; }
  }
  if (!root || typeof root !== 'object') return false;

  const configurationEntry = getAppleTvUtsConfigurationEntry(root);
  if (configurationEntry?.configureParams && configurationEntry?.configuration) {
    appleTvUtsSession = configurationEntry;
  }
  const entries = Array.isArray(root.data) ? root.data : [];
  const showEntry = entries.find(entry => entry?.intent?.$kind === 'ShowPageIntent');
  const episodeEntry = entries.find(entry => entry?.intent?.$kind === 'EpisodePageIntent');
  const showId = showEntry?.intent?.id || episodeEntry?.intent?.showId || readAppleTvShowId();
  if (showId) appleTvPendingShowId = showId;
  if (showEntry) {
    const title = readAppleTvPageTitle() || showEntry.data?.seoData?.pageTitle;
    if (title && showId) updateAppleTvShow(title, showId);
  }
  processAppleTvMetadata(root, '', showId);
  maybeStartAppleTvSeriesCapture();
  return true;
}

function buildAppleTvUtsRequest(routeName, routeParams, queryOverrides = {}) {
  const configureParams = appleTvUtsSession?.configureParams;
  const configuration = appleTvUtsSession?.configuration;
  const route = configuration?.applicationProps?.routes?.[routeName];
  const requiredParams = configuration?.applicationProps?.requiredParamsMap?.[route?.requiredParamsType];
  if (!configureParams?.baseUrl || !configureParams?.developerToken || !route?.path || !requiredParams) return null;

  const consumed = new Set();
  const path = route.path.replace(/\{([\w-]+)\}/g, (match, key) => {
    if (routeParams[key] == null) return match;
    consumed.add(key);
    return encodeURIComponent(routeParams[key]);
  });
  if (/\{[\w-]+\}/.test(path)) return null;
  const url = new URL(`${String(configureParams.baseUrl).replace(/\/+$/, '')}${path}`);
  const query = { ...requiredParams, ...routeParams, ...queryOverrides };
  for (const [key, value] of Object.entries(query)) {
    if (consumed.has(key) || value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const headers = { Authorization: `Bearer ${configureParams.developerToken}` };
  if (configureParams.userToken) headers['Media-User-Token'] = configureParams.userToken;
  return { url: url.toString(), headers };
}

async function fetchAppleTvSeriesCatalog(showId) {
  ensureAppleTvState();
  const normalizedShowId = String(showId || '').trim();
  if (!APPLE_TV_ID_PATTERN.test(normalizedShowId) || !appleTvNativeFetch) return { episodeCount: 0, manifestCount: 0 };

  let nextToken = '';
  let page = 0;
  let episodeCount = 0;
  let manifestCount = 0;
  let totalEpisodeCount = null;
  const seenEpisodeIds = new Set();

  do {
    const request = buildAppleTvUtsRequest('getShowEpisodes', { showId: normalizedShowId }, {
      includeSeasonSummary: true,
      selectedSeasonEpisodesOnly: false,
      ...(nextToken ? { nextToken } : {}),
    });
    if (!request) throw new Error('Apple TV UTS configuration is incomplete');
    const response = await appleTvNativeFetch(request.url, {
      method: 'GET',
      headers: request.headers,
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`Apple TV catalogue returned HTTP ${response.status}`);
    const payload = await response.json();
    const result = processAppleTvMetadata(payload, request.url, normalizedShowId);
    const pageEpisodeIds = findAppleTvCatalogNodes(payload?.data || payload)
      .flatMap(catalog => catalog.episodes || [])
      .map(episode => String(episode?.id || ''))
      .filter(Boolean);
    if (pageEpisodeIds.length) {
      pageEpisodeIds.forEach(id => seenEpisodeIds.add(id));
      episodeCount = seenEpisodeIds.size;
    } else {
      episodeCount += result.episodeCount;
    }
    manifestCount += result.manifestCount;
    const data = payload?.data || payload;
    totalEpisodeCount = coerceAppleTvInteger(data?.totalEpisodeCount) || totalEpisodeCount;
    nextToken = String(data?.nextToken || data?.episodesNextToken || '').trim();
    if (!nextToken && totalEpisodeCount && episodeCount < totalEpisodeCount) {
      nextToken = `${episodeCount}:${APPLE_TV_CATALOG_PAGE_SIZE}`;
    }
    page++;
  } while (nextToken && page < APPLE_TV_MAX_CATALOG_PAGES);

  state.appleTvCatalogShowIds.add(normalizedShowId);
  if (manifestCount) {
    console.info(`[ATVE] Series-wide timestamp fetch started for ${episodeCount} episode(s).`);
  } else {
    console.info(`[ATVE] Series catalogue captured for ${episodeCount} episode(s); timestamps will be fetched per episode during playback.`);
  }
  return { episodeCount, manifestCount };
}

function processAppleTvResponse(response, requestUrl = '') {
  const url = response?.url || requestUrl;
  const contentType = response?.headers?.get?.('content-type') || '';
  if (/\.m3u8(?:$|\?)/i.test(url) || /mpegurl/i.test(contentType)) {
    response.clone().text().then(text => processAppleTvHlsManifest(text, url)).catch(() => {});
    return;
  }
  if (/\/api\/uts\//i.test(url) || /json/i.test(contentType)) {
    response.clone().json().then(data => processAppleTvMetadata(data, url)).catch(() => {});
  }
}

function captureAppleTvSerializedNode(node) {
  if (!node) return false;
  if (node.nodeType === 1 && node.id === APPLE_TV_SERIALIZED_DATA_ID) {
    return processAppleTvSerializedServerData(node.textContent || '');
  }
  const nested = node.querySelector?.(`#${APPLE_TV_SERIALIZED_DATA_ID}`);
  return nested ? processAppleTvSerializedServerData(nested.textContent || '') : false;
}

function setupAppleTvSerializedDataObserver() {
  captureAppleTvSerializedNode(document.getElementById?.(APPLE_TV_SERIALIZED_DATA_ID));
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes || []) captureAppleTvSerializedNode(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

function setupAppleTvFetchInterception(win) {
  if (typeof win.fetch !== 'function') return;
  appleTvNativeFetch = win.fetch.bind(win);
  win.fetch = async function AppleTvInterceptedFetch(input, init) {
    const response = await appleTvNativeFetch(input, init);
    const requestUrl = typeof input === 'string' ? input : input?.url || '';
    processAppleTvResponse(response, requestUrl);
    return response;
  };
}

function setupAppleTvXhrInterception(win) {
  const OriginalXHR = win.XMLHttpRequest;
  if (typeof OriginalXHR !== 'function') return;
  win.XMLHttpRequest = function AppleTvInterceptedXHR() {
    const xhr = new OriginalXHR();
    let requestUrl = '';
    const originalOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      requestUrl = String(url || '');
      return originalOpen(method, url, ...rest);
    };
    xhr.addEventListener('load', () => {
      const responseUrl = xhr.responseURL || requestUrl;
      try {
        if (/\.m3u8(?:$|\?)/i.test(responseUrl)) {
          processAppleTvHlsManifest(String(xhr.responseText || ''), responseUrl);
        } else if (/\/api\/uts\//i.test(responseUrl)) {
          const data = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
          processAppleTvMetadata(data, responseUrl);
        }
      } catch (_) {}
    });
    return xhr;
  };
  win.XMLHttpRequest.prototype = OriginalXHR.prototype;
}

function setupAppleTvInterception() {
  ensureAppleTvState();
  const showId = readAppleTvShowId();
  if (showId) appleTvPendingShowId = showId;
  const isShowPage = /\/show\//i.test(typeof location === 'undefined' ? '' : location.pathname);
  if (isShowPage) {
    const title = readAppleTvPageTitle();
    if (showId && title) updateAppleTvShow(title, showId);
  }
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  setupAppleTvFetchInterception(win);
  setupAppleTvXhrInterception(win);
  setupAppleTvSerializedDataObserver();
  document.addEventListener('DOMContentLoaded', () => {
    const currentShowId = readAppleTvShowId();
    if (currentShowId) appleTvPendingShowId = currentShowId;
    if (/\/show\//i.test(location.pathname)) {
      const currentTitle = readAppleTvPageTitle();
      if (currentShowId && currentTitle) updateAppleTvShow(currentTitle, currentShowId);
    }
    maybeStartAppleTvSeriesCapture();
  }, { once: true });
}


  // â”€â”€â”€ providers/apple-tv/index.js â”€â”€â”€

/** Apple TV provider registration. */
bootstrapProvider({
  providerName: 'apple-tv',
  setupInterception: setupAppleTvInterception,
});

  }

  // Provider registration: videoland
  if (location.hostname === 'videoland.com' || location.hostname.endsWith('.videoland.com')) {

  // â”€â”€â”€ providers/videoland/extractor.js â”€â”€â”€

/**
 * Videoland-specific extraction logic.
 * Captures /layout responses and joins root episode metadata to video chapters.
 */



const VIDEOLAND_LAYOUT_URL_MATCH = /\/layout(\?|$)/i;

function ensureVideolandState() {
  if (!(state.clipMap instanceof Map)) state.clipMap = new Map();
  if (state.currentSeason == null) state.currentSeason = 1;
  if (state.currentEpisode == null) state.currentEpisode = 1;
}

function coerceVideolandNumber(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

function extractVideolandRootMeta(json) {
  const video = json?.seo?.video || null;
  const entity = json?.entity || null;
  return {
    entityId: entity?.id != null ? String(entity.id) : null,
    entity,
    season: coerceVideolandNumber(video?.season),
    episode: coerceVideolandNumber(video?.episode),
    duration: coerceVideolandNumber(video?.duration),
    programId: json?.seo?.parent?.id != null ? String(json.seo.parent.id) : null,
    programTitle: json?.seo?.parent?.name || null,
    episodeTitle: video?.name || video?.title || null,
    extraTitle: video?.extraTitle || null,
  };
}

function extractVideolandVideosWithChapters(root) {
  const found = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.itemContent?.video && Array.isArray(node.itemContent.video.chapters)) found.push(node.itemContent);
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) walk(node[key]);
    }
  }
  walk(root);
  return found;
}

function mapVideolandChapterType(type) {
  if (type === 'intro') return 'recap';
  if (type === 'opening_credits' || type === 'openingcredits') return 'intro';
  if (type === 'ending_credits' || type === 'endingcredits') return 'outro';
  return null;
}

function updateVideolandTitle(title, programId) {
  const showId = String(programId || title);
  handleDetectedShow({ title, showId });
  return showId;
}

function normalizeVideolandEpisodeTitle(value) {
  return String(value || '').trim().replace(/^\d+\s*\.\s*/, '').trim();
}

function chooseVideolandEpisodeTitle(rootMeta, activeItem, programTitle) {
  const candidates = [
    rootMeta?.entity?.extraTitle,
    rootMeta?.entity?.episodeTitle,
    rootMeta?.entity?.episodeName,
    rootMeta?.entity?.subtitle,
    rootMeta?.entity?.subTitle,
    rootMeta?.entity?.secondaryTitle,
    rootMeta?.entity?.title,
    rootMeta?.entity?.name,
    activeItem?.episodeTitle,
    activeItem?.episodeName,
    activeItem?.extraTitle,
    activeItem?.subtitle,
    activeItem?.subTitle,
    activeItem?.secondaryTitle,
    activeItem?.video?.episodeTitle,
    activeItem?.video?.episodeName,
    activeItem?.video?.extraTitle,
    activeItem?.video?.subtitle,
    activeItem?.video?.subTitle,
    activeItem?.video?.secondaryTitle,
    activeItem?.title,
    activeItem?.video?.title,
    activeItem?.video?.name,
    rootMeta?.extraTitle,
    rootMeta?.episodeTitle,
  ].map(normalizeVideolandEpisodeTitle).filter(Boolean);
  const normalizedProgramTitle = String(programTitle || '').trim().toLocaleLowerCase();
  return candidates.find(candidate => candidate.toLocaleLowerCase() !== normalizedProgramTitle) || '';
}

function processVideolandLayout(json) {
  ensureVideolandState();
  let rootMeta;
  let videoItems;
  try {
    rootMeta = extractVideolandRootMeta(json);
    videoItems = extractVideolandVideosWithChapters(json);
  } catch (error) {
    console.error('[VLE] Failed to traverse layout JSON:', error);
    return;
  }
  if (!videoItems.length) return;

  let activeItem = null;
  if (rootMeta.entityId) {
    activeItem = videoItems.find(item => String(item.video.id) === rootMeta.entityId);
  }
  if (!activeItem) activeItem = videoItems[0];

  const clipId = String(activeItem.video.id);
  const season = rootMeta.season;
  const episode = rootMeta.episode;
  const title = (rootMeta.programTitle || activeItem.title || '').trim();
  const episodeTitle = chooseVideolandEpisodeTitle(rootMeta, activeItem, title);
  if (!episodeTitle) {
    console.warn('[VLE] No episode-specific title found; the series title will not be used for TVDB matching.', {
      clipId,
      seriesTitle: title,
    });
  }
  const showId = updateVideolandTitle(title, rootMeta.programId);
  state.clipMap.set(clipId, { season, episode, title, showId });

  if (season != null && episode != null) {
    state.currentSeason = season;
    state.currentEpisode = episode;
  }
  recordProviderEpisode({ providerId: clipId, season, episode, title: episodeTitle }, showId);

  if (season == null || episode == null) return;
  const extractedItems = [];
  for (const chapter of activeItem.video.chapters || []) {
    const segmentType = mapVideolandChapterType(chapter.type);
    const startSec = coerceVideolandNumber(chapter.tcStart);
    const endSec = coerceVideolandNumber(chapter.tcEnd);
    if (!segmentType || startSec == null || endSec == null) continue;

    const episodeId = `${clipId}_${segmentType}`;
    if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;
    extractedItems.push({
      _eid: episodeId,
      _episodeTitle: episodeTitle,
      _showId: showId,
      _tvdbEpisodeLanguages: ['eng', 'nld'],
      _tvdbRequireTitleMatch: true,
      imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: startSec,
      end_sec: endSec,
    });
  }
  logCapturedTimestamps({
    prefix: 'VLE',
    showTitle: title,
    season,
    episode,
    episodeTitle,
    providerIdLabel: 'clipId',
    providerId: clipId,
    items: extractedItems,
  });
  recordExtractedSegments(extractedItems);
}

function setupVideolandInterception() {
  ensureVideolandState();
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const originalFetch = win.fetch.bind(win);
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const responsePromise = originalFetch(input, init);
    if (VIDEOLAND_LAYOUT_URL_MATCH.test(url)) {
      responsePromise.then(response => response.clone().json())
        .then(processVideolandLayout)
        .catch(error => console.warn('[VLE] Failed to process fetch response:', error));
    }
    return responsePromise;
  };

  const OriginalXHR = win.XMLHttpRequest;
  function VideolandInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = requestUrl;
      return originalOpen(method, requestUrl, ...rest);
    };
    xhr.send = function (...args) {
      if (url && VIDEOLAND_LAYOUT_URL_MATCH.test(url)) {
        xhr.addEventListener('load', () => {
          try { processVideolandLayout(JSON.parse(xhr.responseText)); }
          catch (error) { console.error('[VLE] Failed to process XHR response:', error); }
        });
      }
      return originalSend(...args);
    };
    return xhr;
  }
  Object.setPrototypeOf(VideolandInterceptedXHR, OriginalXHR);
  VideolandInterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = VideolandInterceptedXHR;
}


  // â”€â”€â”€ providers/videoland/index.js â”€â”€â”€

/** Videoland provider registration. */


bootstrapProvider({
  providerName: 'videoland',
  setupInterception: setupVideolandInterception,
});

  }

  // Provider registration: skyshowtime
  if (location.hostname === 'skyshowtime.com' || location.hostname.endsWith('.skyshowtime.com')) {

  // â”€â”€â”€ providers/skyshowtime/extractor.js â”€â”€â”€

/**
 * SkyShowtime-specific catalogue interception and segment extraction.
 *
 * Catalogue responses can be requested by either the page or a dedicated
 * worker. Both paths are observed, with a Resource Timing + GM request as a
 * fallback when only the exact catalogue URL is visible to the userscript.
 */



const SKYSHOWTIME_WORKER_MESSAGE = '__segmentScraperSkyShowtime';
const SKYSHOWTIME_CATALOGUE_HOST = 'atom.skyshowtime.com';
const SKYSHOWTIME_CATALOGUE_PATH = '/adapter-calypso/';
const SKYSHOWTIME_SERIES_PATH = '/provider_series_id/';

function coerceSkyShowtimeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function roundSkyShowtimeSeconds(value) {
  return Math.round(value * 1000) / 1000;
}

function isSkyShowtimeCatalogueUrl(url) {
  const value = String(url || '');
  return value.includes(SKYSHOWTIME_CATALOGUE_HOST) &&
    value.includes(SKYSHOWTIME_CATALOGUE_PATH) &&
    value.includes(SKYSHOWTIME_SERIES_PATH);
}

function looksLikeSkyShowtimeEpisode(node) {
  if (!node || typeof node !== 'object' || node.episodeNumber == null) return false;
  const hasRuntime = node.durationMilliseconds != null || node.durationSeconds != null;
  const hasContext = Boolean(node.seriesName || node.providerSeriesId || node.providerVariantId || node.episodeName);
  const hasFormats = Boolean(node.formats && typeof node.formats === 'object');
  return hasRuntime || hasContext || hasFormats;
}

function extendSkyShowtimeContext(context, attributes) {
  if (!attributes || typeof attributes !== 'object') return context;
  return {
    seasonNumber: attributes.seasonNumber ?? context.seasonNumber,
    providerSeriesId: attributes.providerSeriesId || context.providerSeriesId,
    seriesId: attributes.seriesId || context.seriesId,
    seriesUuid: attributes.seriesUuid || context.seriesUuid,
    seriesName: attributes.seriesName || context.seriesName,
    year: attributes.year ?? context.year,
  };
}

/** Find episode attributes while inheriting series/season data from parent nodes. */
function findSkyShowtimeEpisodes(root) {
  const found = [];
  const visited = new WeakSet();

  function walk(node, inheritedContext = {}) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, inheritedContext));
      return;
    }

    const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
    const context = extendSkyShowtimeContext(inheritedContext, attributes);
    if (looksLikeSkyShowtimeEpisode(attributes)) {
      found.push({
        ...context,
        ...attributes,
        seasonNumber: attributes.seasonNumber ?? context.seasonNumber,
        providerSeriesId: attributes.providerSeriesId || context.providerSeriesId,
        seriesId: attributes.seriesId || context.seriesId,
        seriesUuid: attributes.seriesUuid || context.seriesUuid,
        seriesName: attributes.seriesName || context.seriesName,
        year: attributes.year ?? context.year,
      });
    }

    for (const value of Object.values(node)) walk(value, context);
  }

  walk(root);
  const episodeKeys = new Set();
  return found.filter(episode => {
    const key = [
      episode.providerSeriesId || episode.seriesId || episode.seriesUuid || 'series',
      episode.seasonNumber ?? '?',
      episode.episodeNumber ?? '?',
      episode.providerVariantId || episode.programmeUuid || episode.id || episode.episodeName || 'episode',
    ].join('::');
    if (episodeKeys.has(key)) return false;
    episodeKeys.add(key);
    return true;
  });
}

function getSkyShowtimeFormat(episode) {
  const formats = episode?.formats;
  if (!formats || typeof formats !== 'object') return null;
  const candidates = [formats.HD, formats.UHDSDR, ...Object.values(formats)]
    .filter(format => format && typeof format === 'object');
  return candidates.find(format => format.markers || format.startOfCredits != null) || candidates[0] || null;
}

function isSkyShowtimeSpecialEpisode(episode) {
  if (Number(episode.seasonNumber) === 0 || episode.isSpecial === true) return true;
  const type = String(episode.type || episode.episodeType || '').trim().toLowerCase();
  return ['special', 'specials', 'bonus', 'extra', 'extras', 'trailer', 'trailers'].includes(type);
}

function makeSkyShowtimeEpisodeId(episode, season, episodeNumber) {
  const seriesId = episode.providerSeriesId || episode.seriesId || episode.seriesUuid || 'series';
  const variantId = episode.providerVariantId || episode.programmeUuid || episode.id || episode.episodeName || 'variant';
  return `${seriesId}::S${season}E${episodeNumber}::${variantId}`;
}

function addSkyShowtimeSegment(extractedItems, common, providerSegmentType, startMs, endMs) {
  if (startMs == null || endMs == null || endMs <= startMs) return;
  const episodeId = `${common.episodeId}::${providerSegmentType}`;
  if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) return;
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: common.episodeTitle,
    _showId: common.showId,
    imdb_id: state.imdbIdsByShowId?.[common.showId] || 'IMDB_PENDING',
    segment_type: providerSegmentType,
    season: common.season,
    episode: common.episode,
    start_sec: roundSkyShowtimeSeconds(startMs / 1000),
    end_sec: roundSkyShowtimeSeconds(endMs / 1000),
  });
}

/** Parse SOI/EOI, SOR/EOR and SOCR/runtime markers from a catalogue response. */
function processSkyShowtimeMetadata(data, sourceUrl = '') {
  const episodes = findSkyShowtimeEpisodes(data);
  if (!episodes.length) return 0;

  const showEpisode = episodes.find(episode => episode.seriesName || episode.titleLong || episode.titleMedium || episode.title);
  const showId = showEpisode
    ? showEpisode.providerSeriesId || showEpisode.seriesId || showEpisode.seriesUuid || null
    : null;
  const showTitle = showEpisode
    ? showEpisode.seriesName || showEpisode.titleLong || showEpisode.titleMedium || showEpisode.title
    : '';
  if (showEpisode) {
    handleDetectedShow({
      title: showTitle,
      showId,
      year: showEpisode.year || '',
    });
  }

  setProviderEpisodeCatalog(episodes.flatMap(episode => {
    const season = coerceSkyShowtimeNumber(episode.seasonNumber);
    const episodeNumber = coerceSkyShowtimeNumber(episode.episodeNumber);
    if (season == null || episodeNumber == null) return [];
    return [{
      providerId: episode.providerVariantId || episode.programmeUuid || episode.id || makeSkyShowtimeEpisodeId(episode, season, episodeNumber),
      season,
      episode: episodeNumber,
      title: episode.episodeName || episode.titleLong || episode.titleMedium || episode.title || '',
      isSpecial: isSkyShowtimeSpecialEpisode(episode),
    }];
  }), showId);

  const extractedItems = [];
  for (const episode of episodes) {
    const season = coerceSkyShowtimeNumber(episode.seasonNumber);
    const episodeNumber = coerceSkyShowtimeNumber(episode.episodeNumber);
    const durationMilliseconds = coerceSkyShowtimeNumber(episode.durationMilliseconds);
    const durationSeconds = coerceSkyShowtimeNumber(episode.durationSeconds);
    const durationMs = durationMilliseconds ?? (durationSeconds == null ? null : durationSeconds * 1000);
    const format = getSkyShowtimeFormat(episode);
    const markers = format?.markers || {};
    if (season == null || episodeNumber == null || !format) continue;

    const common = {
      episodeId: makeSkyShowtimeEpisodeId(episode, season, episodeNumber),
      episodeTitle: episode.episodeName || episode.titleLong || episode.titleMedium || episode.title || '',
      showId: episode.providerSeriesId || episode.seriesId || episode.seriesUuid || showId || 'unknown-series',
      season,
      episode: episodeNumber,
    };
    const episodeItems = [];
    addSkyShowtimeSegment(
      episodeItems,
      common,
      'recap',
      coerceSkyShowtimeNumber(markers.SOR),
      coerceSkyShowtimeNumber(markers.EOR)
    );
    addSkyShowtimeSegment(
      episodeItems,
      common,
      'intro',
      coerceSkyShowtimeNumber(markers.SOI),
      coerceSkyShowtimeNumber(markers.EOI)
    );
    addSkyShowtimeSegment(
      episodeItems,
      common,
      'outro',
      coerceSkyShowtimeNumber(markers.SOCR) ?? coerceSkyShowtimeNumber(format.startOfCredits),
      durationMs
    );
    extractedItems.push(...episodeItems);
    logCapturedTimestamps({
      prefix: 'SSE',
      showTitle: episode.seriesName || showTitle || state.showTitle,
      season,
      episode: episodeNumber,
      episodeTitle: common.episodeTitle,
      providerIdLabel: 'providerVariantId',
      providerId: episode.providerVariantId || episode.programmeUuid || episode.id || common.episodeId,
      items: episodeItems,
    });
  }

  if (extractedItems.length) {
    recordExtractedSegments(extractedItems);
    console.info(`[SSE] Captured ${extractedItems.length} segment(s) from ${sourceUrl || 'SkyShowtime metadata'}.`);
  }
  return extractedItems.length;
}

function getSkyShowtimeRequestUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function getGmRequest() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) ||
    (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
    (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

function buildSkyShowtimeWorkerSource(originalUrl, isModule) {
  const targetHost = JSON.stringify(SKYSHOWTIME_CATALOGUE_HOST);
  const targetPath = JSON.stringify(SKYSHOWTIME_CATALOGUE_PATH);
  const seriesPath = JSON.stringify(SKYSHOWTIME_SERIES_PATH);
  const messageKey = JSON.stringify(SKYSHOWTIME_WORKER_MESSAGE);
  const importStatement = isModule
    ? `import(${JSON.stringify(originalUrl)});`
    : `importScripts(${JSON.stringify(originalUrl)});`;
  return `
    (() => {
      const messageKey = ${messageKey};
      const isTarget = url => {
        const value = String(url || '');
        return value.includes(${targetHost}) && value.includes(${targetPath}) && value.includes(${seriesPath});
      };
      const sendResponse = (response, url, via) => {
        response.clone().json().then(data => {
          self.postMessage({ [messageKey]: true, type: 'metadata', url, via, data });
        }).catch(() => {});
      };
      if (typeof self.fetch === 'function') {
        const originalFetch = self.fetch.bind(self);
        self.fetch = async function(input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const response = await originalFetch(input, init);
          if (isTarget(url)) sendResponse(response, url, 'worker-fetch');
          return response;
        };
      }
      if (typeof self.XMLHttpRequest === 'function') {
        const originalOpen = self.XMLHttpRequest.prototype.open;
        const originalSend = self.XMLHttpRequest.prototype.send;
        self.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__segmentScraperSkyUrl = url;
          return originalOpen.call(this, method, url, ...rest);
        };
        self.XMLHttpRequest.prototype.send = function(...args) {
          const url = this.__segmentScraperSkyUrl;
          if (isTarget(url)) {
            this.addEventListener('load', () => {
              try {
                const data = JSON.parse(this.responseText);
                self.postMessage({ [messageKey]: true, type: 'metadata', url, via: 'worker-xhr', data });
              } catch (_) {}
            });
          }
          return originalSend.apply(this, args);
        };
      }
    })();
    ${importStatement}
  `;
}

function installSkyShowtimeWorkerBridge(win, onMetadata) {
  const OriginalWorker = win.Worker;
  if (typeof OriginalWorker !== 'function' || !win.Blob || !win.URL?.createObjectURL) return;

  function SkyShowtimeWorker(scriptUrl, options) {
    const args = options === undefined ? [scriptUrl] : [scriptUrl, options];
    let wrapperUrl = '';
    try {
      const originalUrl = new win.URL(String(scriptUrl), win.document.baseURI).href;
      const source = buildSkyShowtimeWorkerSource(originalUrl, options?.type === 'module');
      wrapperUrl = win.URL.createObjectURL(new win.Blob([source], { type: 'text/javascript' }));
      const workerArgs = options === undefined ? [wrapperUrl] : [wrapperUrl, options];
      const worker = Reflect.construct(OriginalWorker, workerArgs, OriginalWorker);
      worker.addEventListener('message', event => {
        const message = event.data;
        if (!message || message[SKYSHOWTIME_WORKER_MESSAGE] !== true) return;
        event.stopImmediatePropagation();
        if (message.type === 'metadata' && message.data) onMetadata(message.data, message.url || '', message.via || 'worker');
      }, true);
      setTimeout(() => win.URL.revokeObjectURL(wrapperUrl), 1000);
      return worker;
    } catch (error) {
      if (wrapperUrl) win.URL.revokeObjectURL(wrapperUrl);
      console.warn('[SSE] Worker bridge unavailable for one worker; using the original worker.', error);
      return Reflect.construct(OriginalWorker, args, OriginalWorker);
    }
  }

  Object.setPrototypeOf(SkyShowtimeWorker, OriginalWorker);
  SkyShowtimeWorker.prototype = OriginalWorker.prototype;
  win.Worker = SkyShowtimeWorker;
}

function isSkyShowtimePlayerPage() {
  return location.pathname.includes('/watch/playback/') || Boolean(document.querySelector('video'));
}

function setupSkyShowtimeInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const fetchedUrls = new Set();
  const originalFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;

  const processCapturedMetadata = (data, url, via) => {
    if (url) fetchedUrls.add(url);
    try {
      processSkyShowtimeMetadata(data, `${via}: ${url}`);
    } catch (error) {
      console.error('[SSE] Failed to process SkyShowtime catalogue metadata:', error);
    }
  };

  if (originalFetch) {
    win.fetch = async function (input, init) {
      const url = getSkyShowtimeRequestUrl(input);
      const response = await originalFetch(input, init);
      if (isSkyShowtimeCatalogueUrl(url)) {
        response.clone().json()
          .then(data => processCapturedMetadata(data, url, 'page-fetch'))
          .catch(error => console.warn('[SSE] Failed to read page fetch response:', error));
      }
      return response;
    };
  }

  const OriginalXHR = win.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    function SkyShowtimeInterceptedXHR() {
      const xhr = new OriginalXHR();
      let url = '';
      const originalOpen = xhr.open.bind(xhr);
      const originalSend = xhr.send.bind(xhr);
      xhr.open = function (method, requestUrl, ...rest) {
        url = String(requestUrl || '');
        return originalOpen(method, requestUrl, ...rest);
      };
      xhr.send = function (...args) {
        if (isSkyShowtimeCatalogueUrl(url)) {
          xhr.addEventListener('load', () => {
            try { processCapturedMetadata(JSON.parse(xhr.responseText), url, 'page-xhr'); }
            catch (error) { console.warn('[SSE] Failed to read page XHR response:', error); }
          });
        }
        return originalSend(...args);
      };
      return xhr;
    }
    Object.setPrototypeOf(SkyShowtimeInterceptedXHR, OriginalXHR);
    SkyShowtimeInterceptedXHR.prototype = OriginalXHR.prototype;
    win.XMLHttpRequest = SkyShowtimeInterceptedXHR;
  }

  installSkyShowtimeWorkerBridge(win, processCapturedMetadata);

  const refetchCatalogue = url => {
    if (!isSkyShowtimeCatalogueUrl(url) || fetchedUrls.has(url)) return;
    fetchedUrls.add(url);
    const gmRequest = getGmRequest();
    if (gmRequest) {
      gmRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            fetchedUrls.delete(url);
            console.warn(`[SSE] Catalogue refetch returned HTTP ${response.status}.`);
            return;
          }
          try { processCapturedMetadata(JSON.parse(response.responseText), url, 'resource-refetch'); }
          catch (error) { console.warn('[SSE] Failed to parse catalogue refetch:', error); }
        },
        onerror: () => {
          fetchedUrls.delete(url);
          console.warn('[SSE] Catalogue refetch failed.');
        },
        ontimeout: () => {
          fetchedUrls.delete(url);
          console.warn('[SSE] Catalogue refetch timed out.');
        },
      });
      return;
    }
    if (originalFetch) {
      originalFetch(url, { credentials: 'include' })
        .then(response => response.json())
        .then(data => processCapturedMetadata(data, url, 'resource-refetch'))
        .catch(error => {
          fetchedUrls.delete(url);
          console.warn('[SSE] Catalogue refetch failed:', error);
        });
    }
  };

  const scanResourceEntries = entries => {
    for (const entry of entries || []) refetchCatalogue(entry?.name || '');
  };
  try { scanResourceEntries(win.performance?.getEntriesByType('resource')); } catch (_) {}
  if (typeof win.PerformanceObserver === 'function') {
    try {
      const observer = new win.PerformanceObserver(list => scanResourceEntries(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    } catch (error) {
      console.warn('[SSE] Resource observer unavailable:', error);
    }
  }
}


  // â”€â”€â”€ providers/skyshowtime/index.js â”€â”€â”€

/** SkyShowtime provider registration. */


bootstrapProvider({
  providerName: 'skyshowtime',
  setupInterception: setupSkyShowtimeInterception,
  isPlayerPage: isSkyShowtimePlayerPage,
});

  }

  // Provider registration: crunchyroll
  if (location.hostname === 'crunchyroll.com' || location.hostname.endsWith('.crunchyroll.com')) {

  // â”€â”€â”€ providers/crunchyroll/extractor.js â”€â”€â”€

/** Crunchyroll page metadata and skip-event extraction. */





const CRUNCHYROLL_SKIP_EVENTS_BASE = 'https://static.crunchyroll.com/skip-events/production';
const CRUNCHYROLL_SCAN_INTERVAL_MS = 750;

function ensureCrunchyrollState() {
  if (!(state.crunchyrollRegisteredEpisodes instanceof Set)) state.crunchyrollRegisteredEpisodes = new Set();
  if (!(state.crunchyrollRequestedWatchIds instanceof Set)) state.crunchyrollRequestedWatchIds = new Set();
}

function coerceCrunchyrollInteger(value, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  return number > 0 || (allowZero && number === 0) ? number : null;
}

function hasSchemaType(item, type) {
  const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
  return types.includes(type);
}

function flattenStructuredData(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach(item => flattenStructuredData(item, output));
    return output;
  }
  output.push(value);
  if (Array.isArray(value['@graph'])) flattenStructuredData(value['@graph'], output);
  return output;
}

function extractCrunchyrollSeriesId(value) {
  const match = String(value || '').match(/\/series\/([A-Z0-9]+)/i);
  return match ? match[1].toUpperCase() : null;
}

function normalizeCrunchyrollEpisodeTitle(value, episodeNumber) {
  const title = String(value || '').trim();
  if (!title) return '';
  return title
    .replace(/^.*?\|\s*E(?:pisode\s*)?\d+(?:\.\d+)?\s*[-:|]\s*/i, '')
    .replace(new RegExp(`^E(?:pisode\\s*)?${episodeNumber}\\s*[-:|]\\s*`, 'i'), '')
    .trim();
}

/** Return the Crunchyroll watch identifier from normal and localized player paths. */
function getCrunchyrollWatchId(pathname = location.pathname) {
  const match = String(pathname || '').match(/(?:^|\/)watch\/([A-Z0-9]+)(?:\/|$)/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Read the current episode from Crunchyroll's server-rendered schema.org data.
 * Keeping this independent of player internals makes it work before playback
 * starts and across both the legacy and current web players.
 */
function readCrunchyrollPageMetadata(doc = document, pathname = location.pathname) {
  const watchId = getCrunchyrollWatchId(pathname);
  if (!watchId || !doc?.querySelectorAll) return null;

  const structuredData = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { flattenStructuredData(JSON.parse(script.textContent || ''), structuredData); }
    catch (_) {}
  }

  const episodeData = structuredData.find(item => {
    if (!hasSchemaType(item, 'TVEpisode')) return false;
    const itemWatchId = getCrunchyrollWatchId(item['@id'] || item.url || '');
    return !itemWatchId || itemWatchId === watchId;
  });
  if (!episodeData) return null;

  const season = coerceCrunchyrollInteger(episodeData.partOfSeason?.seasonNumber, { allowZero: true });
  const episode = coerceCrunchyrollInteger(episodeData.episodeNumber);
  const seriesUrl = episodeData.partOfSeries?.['@id'] || episodeData.partOfSeason?.['@id'];
  const showId = extractCrunchyrollSeriesId(seriesUrl);
  const seriesTitle = String(episodeData.partOfSeries?.name || '').trim();
  if (!showId || !seriesTitle || season == null || episode == null) return null;

  const videoData = structuredData.find(item => hasSchemaType(item, 'VideoObject'));
  const episodeTitle = normalizeCrunchyrollEpisodeTitle(
    videoData?.name || episodeData.name,
    episode
  );
  const publishedYear = String(episodeData.datePublished || '').match(/^(\d{4})/);
  const seasonLabel = String(episodeData.partOfSeason?.name || '').trim().toLowerCase();

  return {
    watchId,
    providerId: watchId,
    showId,
    seriesTitle,
    season,
    episode,
    episodeTitle,
    year: season === 1 ? publishedYear?.[1] || '' : '',
    isSpecial: season === 0 || /\b(?:specials?|extras?|bonus|trailers?)\b/.test(seasonLabel),
  };
}

function registerCrunchyrollEpisode(metadata) {
  ensureCrunchyrollState();
  handleDetectedShow({
    title: metadata.seriesTitle,
    showId: metadata.showId,
    year: metadata.year,
  });

  const registrationKey = `${metadata.showId}|${metadata.season}|${metadata.episode}`;
  if (state.crunchyrollRegisteredEpisodes.has(registrationKey)) return;
  state.crunchyrollRegisteredEpisodes.add(registrationKey);
  recordProviderEpisode({
    providerId: metadata.providerId || metadata.watchId,
    season: metadata.season,
    episode: metadata.episode,
    title: metadata.episodeTitle,
    isSpecial: metadata.isSpecial,
  }, metadata.showId);
}

function addCrunchyrollSegment(extractedItems, metadata, skipEvents, providerSegmentType, marker) {
  const startSec = Number(marker?.start);
  const endSec = Number(marker?.end);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) return;

  const mediaId = skipEvents?.mediaId || metadata.providerId || metadata.watchId;
  const episodeId = `${mediaId}:${providerSegmentType}`;
  const normalizedType = providerSegmentType === 'credits' ? 'outro' : providerSegmentType;
  const isDuplicate = item => item._eid === episodeId || (
    String(item._showId || '') === String(metadata.showId) &&
    item.season === metadata.season &&
    item.episode === metadata.episode &&
    item.segment_type === normalizedType
  );
  if (state.allItems.some(isDuplicate) || extractedItems.some(isDuplicate)) return;

  const item = createNormalizedSegment({
    providerName: 'crunchyroll',
    providerSegmentType,
    episodeId,
    showId: metadata.showId,
    season: metadata.season,
    episode: metadata.episode,
    imdbId: state.imdbIdsByShowId?.[metadata.showId] || 'IMDB_PENDING',
    episodeTitle: metadata.episodeTitle,
    startSec,
    endSec,
  });
  if (!item) return;
  item._tvdbEpisodeLanguages = ['eng'];
  item._tvdbRequireTitleMatch = true;
  extractedItems.push(item);
}

/** Register one episode and normalize its public Crunchyroll skip-event payload. */
function processCrunchyrollEpisode(metadata, skipEvents = {}) {
  if (!metadata?.showId || !metadata?.seriesTitle) return 0;
  if (coerceCrunchyrollInteger(metadata.season, { allowZero: true }) == null || coerceCrunchyrollInteger(metadata.episode) == null) return 0;
  registerCrunchyrollEpisode(metadata);

  const extractedItems = [];
  addCrunchyrollSegment(extractedItems, metadata, skipEvents, 'recap', skipEvents.recap);
  addCrunchyrollSegment(extractedItems, metadata, skipEvents, 'intro', skipEvents.intro);
  addCrunchyrollSegment(extractedItems, metadata, skipEvents, 'credits', skipEvents.credits);
  logCapturedTimestamps({
    prefix: 'CRE',
    showTitle: metadata.seriesTitle,
    season: metadata.season,
    episode: metadata.episode,
    episodeTitle: metadata.episodeTitle,
    providerIdLabel: 'mediaId',
    providerId: skipEvents.mediaId || metadata.providerId || metadata.watchId,
    items: extractedItems,
  });
  recordExtractedSegments(extractedItems);
  return extractedItems.length;
}

function getGmRequest() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) ||
    (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
    (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

function loadCrunchyrollSkipEvents(metadata, originalFetch) {
  const url = `${CRUNCHYROLL_SKIP_EVENTS_BASE}/${metadata.watchId}.json`;
  const gmRequest = getGmRequest();
  if (gmRequest) {
    gmRequest({
      method: 'GET',
      url,
      headers: { Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      onload: response => {
        if (response.status === 404) return;
        if (response.status < 200 || response.status >= 300) {
          console.warn(`[CRE] Skip-event request returned HTTP ${response.status}.`);
          return;
        }
        try { processCrunchyrollEpisode(metadata, JSON.parse(response.responseText)); }
        catch (error) { console.warn('[CRE] Failed to parse skip-event response:', error); }
      },
      onerror: () => console.warn('[CRE] Skip-event request failed.'),
      ontimeout: () => console.warn('[CRE] Skip-event request timed out.'),
    });
    return;
  }

  if (originalFetch) {
    originalFetch(url)
      .then(response => response.status === 404 ? null : response.json())
      .then(data => { if (data) processCrunchyrollEpisode(metadata, data); })
      .catch(error => console.warn('[CRE] Skip-event fetch failed:', error));
  }
}

function isCrunchyrollPlayerPage() {
  return Boolean(getCrunchyrollWatchId(location.pathname));
}

function setupCrunchyrollInterception() {
  ensureCrunchyrollState();
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const originalFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;

  const scanCurrentEpisode = () => {
    const metadata = readCrunchyrollPageMetadata(document, location.pathname);
    if (!metadata) return;
    processCrunchyrollEpisode(metadata);
    if (state.crunchyrollRequestedWatchIds.has(metadata.watchId)) return;
    state.crunchyrollRequestedWatchIds.add(metadata.watchId);
    loadCrunchyrollSkipEvents(metadata, originalFetch);
  };

  scanCurrentEpisode();
  document.addEventListener('DOMContentLoaded', scanCurrentEpisode, { once: true });
  setInterval(scanCurrentEpisode, CRUNCHYROLL_SCAN_INTERVAL_MS);
}


  // â”€â”€â”€ providers/crunchyroll/index.js â”€â”€â”€

/** Crunchyroll provider registration. */


bootstrapProvider({
  providerName: 'crunchyroll',
  setupInterception: setupCrunchyrollInterception,
  isPlayerPage: isCrunchyrollPlayerPage,
});

  }
})();
