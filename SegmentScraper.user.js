// ==UserScript==
// @name         SegmentScraper - Multi-Provider Timestamps Extractor
// @namespace    https://github.com/mronion212/SegmentScraper
// @version      1.0.1
// @description  Extracts intro/recap/outro timestamps from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.
// @author       mronion212
// @match        https://www.netflix.com/*
// @match        https://www.disneyplus.com/*
// @match        https://www.primevideo.com/*
// @match        https://www.amazon.*/gp/video/*
// @match        https://*.primevideo.com/*
// @match        https://www.videoland.com/*
// @match        https://videoland.com/*
// @match        https://v2.videoland.com/*
// @match        https://*.videoland.com/*
// @match        https://play.max.com/*
// @match        https://www.skyshowtime.com/*
// @match        https://skyshowtime.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      v3.sg.media-imdb.com
// @connect      api.introdb.app
// @connect      api4.thetvdb.com
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
  interceptedCount: 0,
  panelVisible: false,
  submitInProgress: false,
  submitResults: { ok: 0, fail: 0 },
  dedupCacheV2: {},
  introdbApiKey: '',
  tvdbApiKey: '',
  tvdbPin: '',
  providerEpisodes: [],
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
    if (!unique.has(key)) unique.set(key, {
      providerId: episode.providerId == null ? '' : String(episode.providerId),
      season,
      episode: number,
      title: String(episode.title || '').trim(),
      isSpecial: season === 0 || episode.isSpecial === true,
    });
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
    const contradictsEnglishProviderTitle = language === 'eng' && correspondingProviderTitle &&
      returnedTitle !== correspondingProviderTitle;
    const returnedLanguage = declaredLanguage || language;
    const needsExplicitTranslation = episode?.id != null && (
      !returnedTitle ||
      (declaredLanguage && declaredLanguage !== language) ||
      contradictsEnglishProviderTitle
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

function logTvdbEpisodeLanguageAudit(seriesId, language, episodes) {
  console.info('[TVDB] Series episode language audit', {
    seriesId: String(seriesId),
    requestedLanguage: language,
    endpointUrlShape: TVDB_EPISODE_ENDPOINT_SHAPE,
    returnedEpisodeNameLanguages: summarizeEpisodeNameLanguages(episodes),
  });
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

function findDuplicateNumber(episodes) {
  const seen = new Set();
  for (const episode of episodes) {
    const key = `${episode.season}|${episode.episode}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

function mapEpisodes(providerEpisodes, tvdbEpisodes) {
  const mapping = new Map();
  if (providerEpisodes.length === tvdbEpisodes.length) {
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
    const title = normalizeTitle(episode.title);
    if (!title) continue;
    if (!tvdbByTitle.has(title)) tvdbByTitle.set(title, []);
    tvdbByTitle.get(title).push(episode);
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
    const episodeList = await fetchTvdbEpisodeList(tvdbSeriesId, TVDB_EPISODE_LANGUAGE);
    const localizedEpisodes = await ensureTvdbEpisodeNameLanguage(episodeList, providerEpisodes, TVDB_EPISODE_LANGUAGE);
    logTvdbEpisodeLanguageAudit(tvdbSeriesId, TVDB_EPISODE_LANGUAGE, localizedEpisodes);
    const tvdbCatalog = cleanTvdbEpisodes(localizedEpisodes);
    const tvdbEpisodes = tvdbCatalog.episodes;
    if (!tvdbEpisodes.length) return { success: false, reason: 'TVDB returned no usable episode metadata' };
    const duplicateTvdbNumber = findDuplicateNumber(tvdbEpisodes);
    if (duplicateTvdbNumber) {
      return { success: false, reason: `TVDB metadata has duplicate regular episode number ${duplicateTvdbNumber.replace('|', 'x')}` };
    }
    const result = mapEpisodes(providerEpisodes, tvdbEpisodes);
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
      const { _eid, _episodeTitle, ...submissionItem } = item;
      mappedItems.push({ ...submissionItem, season: match.season, episode: match.episode });
    }
    stats.capturedRegularSegmentsMatched = mappedItems.length;
    stats.capturedRegularSegmentsSkipped = regularItems.length - mappedItems.length;
    return { success: true, items: mappedItems, method: result.method, reason: result.reason, tvdbSeriesId, stats };
  } catch (error) {
    return { success: false, reason: error?.message || 'TVDB mapping failed' };
  }
}

function setProviderEpisodeCatalog(episodes) {
  state.providerEpisodes = normalizeProviderEpisodes(episodes);
}

function recordProviderEpisode(episode) {
  const current = normalizeProviderEpisodes([...(state.providerEpisodes || []), episode]);
  state.providerEpisodes = current;
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
      primary: '#0072CE',
      primaryDark: '#005A9C',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#0072CE',
    infoAccent: '#0072CE',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'SkyShowtime extraction is being prepared. Playback metadata will be added once its API responses are mapped.',
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
  episodeTitle = ''
}) {
  const segmentType = normalizeSegmentType(providerSegmentType, providerName);
  if (!segmentType) return null;
  
  return {
    _eid: episodeId,
    _episodeTitle: episodeTitle,
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
function showExportPreview({ items, fileCount, duplicateCount, shortSegmentCount, downloads, onDownload, onCancel }) {
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
  heading.textContent = `Controleer ${providerName} JSON-export`;
  heading.style.cssText = `margin:0 0 6px; color:${providerColors.primary}; font:700 16px/normal -apple-system,Arial,sans-serif;`;
  const summary = document.createElement('p');
  summary.textContent = `${items.length} timestamps in ${fileCount} bestand(en)${duplicateCount ? `; ${duplicateCount} duplicaten uitgesloten` : ''}${shortSegmentCount ? `; ${shortSegmentCount} korter dan 5 seconden uitgesloten` : ''}.`;
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
  cancel.textContent = 'Annuleren';
  cancel.style.cssText = 'box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; font:13px/normal -apple-system,Arial,sans-serif; cursor:pointer;';
  const confirm = document.createElement('a');
  confirm.href = downloads[0].url;
  confirm.download = downloads[0].filename;
  confirm.textContent = fileCount > 1 ? `Download JSON (1/${fileCount})` : 'Download JSON';
  confirm.style.cssText = `box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:0; border-radius:6px; background:${providerColors.primary}; color:#fff; font:700 13px/normal -apple-system,Arial,sans-serif; cursor:pointer; text-decoration:none;`;

  let downloadIndex = 0;
  const cancelExport = () => {
    onCancel();
    overlay.remove();
  };
  cancel.addEventListener('click', cancelExport);
  overlay.addEventListener('click', event => { if (event.target === overlay) cancelExport(); });
  confirm.addEventListener('click', () => {
    onDownload(downloadIndex);
    downloadIndex++;
    if (downloadIndex >= downloads.length) {
      setTimeout(() => overlay.remove());
      return;
    }
    confirm.style.pointerEvents = 'none';
    setTimeout(() => {
      confirm.href = downloads[downloadIndex].url;
      confirm.download = downloads[downloadIndex].filename;
      confirm.textContent = `Download next JSON (${downloadIndex + 1}/${fileCount})`;
      confirm.style.pointerEvents = 'auto';
    });
  });
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
  if (title && title !== state.showTitle) {
    state.showTitle = title;
    state.showId = showId != null ? String(showId) : null;
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

  if (imdbOverride) {
    state.imdbId = imdbOverride;
    state.allItems.forEach(item => {
      if (item.imdb_id === 'IMDB_PENDING') item.imdb_id = imdbOverride;
    });
    updateImdbInput();
    setDbStatus(`Manual override applied · ID: ${imdbOverride}`);
    updateCounters();
    loadExistingSegments(imdbOverride);
    return;
  }

  searchImdbByTitle(state.showTitle, state.showYear).then(result => {
    if (result.success) {
      state.imdbId = result.imdbId;
      state.allItems.forEach(item => {
        if (item.imdb_id === 'IMDB_PENDING') item.imdb_id = result.imdbId;
      });
      updateImdbInput();
      setDbStatus(`Found: ${result.imdbId}`);
      updateCounters();
      loadExistingSegments(result.imdbId);
    } else {
      setDbStatus(`IMDb lookup failed: ${result.error}`);
    }
  }).catch(error => {
    console.error('[NFE] IMDb search error:', error);
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

function filterShortSegments(items) {
  const filteredItems = items.filter(item => item.end_sec - item.start_sec >= 5);
  return {
    items: filteredItems,
    skipped: items.length - filteredItems.length,
  };
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
    const catalog = imdbId === state.imdbId ? state.providerEpisodes : [];
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
  let items = mapped.items;
  if (!items.length) {
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    toast(onlySpecials ? 'Only provider specials were captured; nothing was exported.' : 'No series has a reliable TVDB episode mapping; nothing was exported.');
    return;
  }

  const shortSegments = filterShortSegments(items);
  items = shortSegments.items;
  if (shortSegments.skipped > 0) {
    toast(`${shortSegments.skipped} segment(s) under 5 seconds removed from export.`);
  }
  if (!items.length) {
    toast('Nothing left to export after removing segments under 5 seconds.');
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

  const downloads = files.map(file => {
    const blob = new Blob([JSON.stringify({ items: file.data }, null, 2)], { type: 'application/json' });
    return {
      url: URL.createObjectURL(blob),
      filename: `timestamps_${file.imdbId}${file.part}.json`,
    };
  });
  let downloaded = 0;
  const revokeDownloads = () => downloads.forEach(download => URL.revokeObjectURL(download.url));

  function handleDownload(index) {
    downloaded++;
    setTimeout(() => URL.revokeObjectURL(downloads[index].url), 1000);
    if (downloaded === downloads.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${items.length} entries`);
    }
  }

  showExportPreview({
    items,
    fileCount: files.length,
    duplicateCount,
    shortSegmentCount: shortSegments.skipped,
    downloads,
    onDownload: handleDownload,
    onCancel: revokeDownloads,
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
  let allMapped = mapped.items;
  if (!allMapped.length) {
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    toast(onlySpecials ? 'Only provider specials were captured; nothing was submitted.' : 'No series has a reliable TVDB episode mapping; nothing was submitted.');
    setIntrodbStatus(onlySpecials ? 'Nothing submitted: specials are excluded' : 'Submission blocked: TVDB mapping unavailable or unreliable');
    stopSubmission();
    return;
  }

  const shortSegments = filterShortSegments(allMapped);
  allMapped = shortSegments.items;
  if (shortSegments.skipped > 0) {
    toast(`${shortSegments.skipped} segment(s) under 5 seconds skipped from IntroDB submission.`);
  }
  if (!allMapped.length) {
    toast('Nothing left to submit after removing segments under 5 seconds.');
    setIntrodbStatus('Nothing submitted: all segments were under 5 seconds');
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

  const skipDetails = [];
  if (shortSegments.skipped > 0) skipDetails.push(`${shortSegments.skipped} under 5 seconds`);
  if (skipped - shortSegments.skipped > 0) skipDetails.push(`${skipped - shortSegments.skipped} otherwise skipped or already existed`);
  const skipMessage = skipDetails.length ? ` (${skipDetails.join('; ')})` : '';
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
      state.allItems.forEach(item => { item.imdb_id = value; });
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
      searchImdbByTitle(query, state.showYear).then(result => {
        if (result.success) {
          state.imdbId = result.imdbId;
          state.allItems.forEach(item => {
            if (item.imdb_id === 'IMDB_PENDING') item.imdb_id = result.imdbId;
          });
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
  ));

  const extractedItems = [];
  for (const season of video.seasons || []) {
    for (const episode of season.episodes || []) {
      const episodeId = episode.episodeId || episode.id;
      if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;

      const common = {
        providerName: 'netflix',
        episodeId,
        season: season.seq,
        episode: episode.seq,
        imdbId: state.imdbId || 'IMDB_PENDING',
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

      for (const segment of segments) {
        const item = createNormalizedSegment({ ...common, ...segment });
        if (item) extractedItems.push(item);
      }
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

/**
 * Prime Video-specific extraction logic.
 * Captures GetVodPlaybackResources transition timecodes and resolves the
 * episode number from the active player DOM.
 */



const PRIME_VIDEO_METADATA_URL_MATCH = 'GetVodPlaybackResources';

function ensurePrimeVideoState() {
  if (!(state.asinMap instanceof Map)) state.asinMap = new Map();
  if (!(state.pendingByAsin instanceof Map)) state.pendingByAsin = new Map();
  if (state.currentSeason == null) state.currentSeason = 1;
  if (state.currentEpisode == null) state.currentEpisode = 1;
}

function findPrimeVideoAsinInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const keys = ['asin', 'ASIN', 'titleId', 'titleID', 'contentId', 'catalogId'];
  for (const key of keys) {
    if (typeof obj[key] === 'string' && /^[A-Z0-9]{9,12}$/i.test(obj[key])) return obj[key];
  }
  for (const key in obj) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      const found = findPrimeVideoAsinInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractPrimeVideoAsin(bodyText, url) {
  if (url) {
    const titleIdMatch = url.match(/[?&]titleId=([^&]+)/i);
    if (titleIdMatch) return decodeURIComponent(titleIdMatch[1]);
    const asinMatch = url.match(/[?&](?:asin|ASIN)=([A-Z0-9]{9,12})/i);
    if (asinMatch) return asinMatch[1];
  }
  if (!bodyText) return null;
  try {
    const found = findPrimeVideoAsinInObject(JSON.parse(bodyText));
    if (found) return found;
  } catch (_) {}

  const patterns = [
    /"asin"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /"titleId"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /"titleID"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /"contentId"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /asin=([A-Z0-9]{9,12})/i,
  ];
  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function readPrimeVideoSeasonEpisode() {
  const player = document.getElementById('dv-web-player');
  const episodeInfo = document.querySelector('[class*="atvwebplayersdk-episode-info"]');
  const isPlayerActive = !!player && player.offsetWidth > 0 && player.offsetHeight > 0;
  let season = null;
  let episode = null;
  let episodeTitle = '';

  if (episodeInfo) {
    const text = episodeInfo.textContent.trim();
    const seasonMatch = text.match(/S(\d+)/i);
    const episodeMatch = text.match(/(?:Afl\.?|E)\s*(\d+)/i);
    if (seasonMatch) season = parseInt(seasonMatch[1], 10);
    if (episodeMatch) episode = parseInt(episodeMatch[1], 10);
    const titleNode = episodeInfo.querySelector('[class*="title" i]');
    const rawEpisodeTitle = (titleNode?.textContent || text).trim();
    episodeTitle = rawEpisodeTitle
      .replace(/^\s*S\d+\s*(?:E|Afl\.?)\s*\d+\s*[-:|.]?\s*/i, '')
      .replace(/^\s*(?:Episode|Aflevering)\s*\d+\s*[-:|.]?\s*/i, '')
      .trim();
    if (episodeTitle === rawEpisodeTitle && seasonMatch && episodeMatch) episodeTitle = '';
  }
  return { isPlayerActive, season, episode, title: document.title, episodeTitle };
}

function updatePrimeVideoTitle(rawTitle) {
  const cleaned = rawTitle.replace(/^Prime Video[:\-]\s*/i, '').trim();
  const seasonMatch = cleaned.match(/\s*(Seizoen|Season)\s*(\d+)/i);
  const title = seasonMatch ? cleaned.slice(0, seasonMatch.index).trim() : cleaned;
  handleDetectedShow({ title, showId: title });
}

function finalizePrimeVideoEvents(asin, season, episode, data, episodeTitle = '') {
  const events = data?.transitionTimecodes?.result?.events || [];
  const extractedItems = [];

  for (const event of events) {
    let segmentType = null;
    if (event.eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (event.eventType === 'SKIP_INTRO') segmentType = 'intro';
    if (!segmentType || typeof event.startTimeMs !== 'number' || typeof event.endTimeMs !== 'number') continue;

    const episodeId = `${asin}_${segmentType}`;
    if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;
    extractedItems.push({
      _eid: episodeId,
      _episodeTitle: episodeTitle,
      imdb_id: state.imdbId || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: event.startTimeMs / 1000,
      end_sec: event.endTimeMs / 1000,
    });
  }
  recordExtractedSegments(extractedItems);
}

function pollPrimeVideoEpisode(asin, attempt) {
  const snapshot = readPrimeVideoSeasonEpisode();
  if (snapshot.isPlayerActive && snapshot.season != null && snapshot.episode != null) {
    state.asinMap.set(asin, { season: snapshot.season, episode: snapshot.episode, episodeTitle: snapshot.episodeTitle });
    state.currentSeason = snapshot.season;
    state.currentEpisode = snapshot.episode;
    updatePrimeVideoTitle(snapshot.title);
    recordProviderEpisode({ providerId: asin, season: snapshot.season, episode: snapshot.episode, title: snapshot.episodeTitle });
    const pending = state.pendingByAsin.get(asin) || [];
    state.pendingByAsin.delete(asin);
    pending.forEach(data => finalizePrimeVideoEvents(asin, snapshot.season, snapshot.episode, data, snapshot.episodeTitle));
    return;
  }
  if (attempt >= 40) {
    console.warn('[PVE] Could not resolve season/episode for ASIN:', asin);
    state.pendingByAsin.delete(asin);
    return;
  }
  setTimeout(() => pollPrimeVideoEpisode(asin, attempt + 1), 250);
}

function processPrimeVideoMetadata(data, bodyText, url) {
  ensurePrimeVideoState();
  const asin = extractPrimeVideoAsin(bodyText, url);
  if (!asin) return;
  if (state.asinMap.has(asin)) {
    const { season, episode, episodeTitle } = state.asinMap.get(asin);
    finalizePrimeVideoEvents(asin, season, episode, data, episodeTitle);
    return;
  }
  if (!state.pendingByAsin.has(asin)) state.pendingByAsin.set(asin, []);
  state.pendingByAsin.get(asin).push(data);
  pollPrimeVideoEpisode(asin, 0);
}

function setupPrimeVideoInterception() {
  ensurePrimeVideoState();
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OriginalXHR = win.XMLHttpRequest;

  function PrimeVideoInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    let bodyText = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = requestUrl;
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
    const url = typeof input === 'string' ? input : (input && input.url) || '';
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
  return {
    entityId: json?.entity?.id != null ? String(json.entity.id) : null,
    season: coerceVideolandNumber(video?.season),
    episode: coerceVideolandNumber(video?.episode),
    duration: coerceVideolandNumber(video?.duration),
    programId: json?.seo?.parent?.id != null ? String(json.seo.parent.id) : null,
    programTitle: json?.seo?.parent?.name || null,
    episodeTitle: video?.name || video?.title || null,
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
  handleDetectedShow({ title, showId: programId });
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
  const episodeTitle = (rootMeta.episodeTitle || activeItem.title || '').trim();
  state.clipMap.set(clipId, { season, episode, title, programId: rootMeta.programId });

  if (season != null && episode != null) {
    state.currentSeason = season;
    state.currentEpisode = episode;
  }
  updateVideolandTitle(title, rootMeta.programId);
  recordProviderEpisode({ providerId: clipId, season, episode, title: episodeTitle });

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
      imdb_id: state.imdbId || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: startSec,
      end_sec: endSec,
    });
  }
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
 * SkyShowtime extraction scaffold.
 *
 * The provider is registered so its panel and trigger are available during
 * playback. Network response shapes still need to be mapped before segment
 * timestamps can be captured.
 */

function isSkyShowtimePlayerPage() {
  return Boolean(document.querySelector('video'));
}

function setupSkyShowtimeInterception() {
  console.info('[SSE] SkyShowtime provider initialized; segment extraction is not mapped yet.');
}


  // â”€â”€â”€ providers/skyshowtime/index.js â”€â”€â”€

/** SkyShowtime provider registration. */


bootstrapProvider({
  providerName: 'skyshowtime',
  setupInterception: setupSkyShowtimeInterception,
  isPlayerPage: isSkyShowtimePlayerPage,
});

  }
})();
