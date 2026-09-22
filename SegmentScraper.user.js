// ==UserScript==
// @name         SegmentScraper - Multi-Provider Timestamps Extractor
// @version      1.12.6
// @namespace    https://github.com/mronion212/SegmentScraper
// @description  Extracts intro/recap/outro timestamps from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.
// @author       mronion212
// @homepageURL  https://github.com/mronion212/SegmentScraper
// @updateURL    https://raw.githubusercontent.com/mronion212/SegmentScraper/main/SegmentScraper.user.js
// @downloadURL  https://raw.githubusercontent.com/mronion212/SegmentScraper/main/SegmentScraper.user.js
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
// @connect      api.themoviedb.org
// @connect      api4.thetvdb.com
// @connect      atom.skyshowtime.com
// @connect      raw.githubusercontent.com
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';
  const _GM_xmlhttpRequest = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null;
  const SEGMENTSCRAPER_VERSION = "1.12.6";
  const SEGMENTSCRAPER_UPDATE_URL = "https://raw.githubusercontent.com/mronion212/SegmentScraper/main/SegmentScraper.user.js";


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
 * Create a cache key for either a TV episode or a movie.
 * Movies intentionally omit season/episode because they do not use TVDB.
 */
function createMediaCacheKey(imdbId, mediaType = 'tv', season, episode) {
  return String(mediaType).toLowerCase() === 'movie'
    ? `${String(imdbId)}|movie`
    : createEpisodeCacheKey(imdbId, season, episode);
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
  knownMovieScenes: [],
  imdbId: '',
  dbSearchDone: false,
  dbStatusMsg: `Waiting for ${providerName} metadata...`,
  showTitle: '',
  mediaType: 'tv',
  showId: null,
  showYear: '',
  showIds: new Set(),
  imdbIdsByShowId: {},
  interceptedCount: 0,
  panelVisible: false,
  submitInProgress: false,
  exportInProgress: false,
  sessionSavedAt: '',
  sessionStorageError: false,
  submitResults: { ok: 0, fail: 0 },
  dedupCacheV2: {},
  introdbApiKey: '',
  tvdbApiKey: '',
  tvdbPin: '',
  providerEpisodes: [],
  providerEpisodesByShowId: {},
  updateStatus: 'idle',
  updateRequired: false,
  currentVersion: '',
  latestVersion: '',
  updateUrl: '',
});

const state = createState('Streaming Service');

/** Shared wire format and timing rules for both clients. Client-specific scene policy stays explicit. */
function isMovieSegment(item) {
  return item?.is_movie === true || String(item?.media_type || item?.mediaType || item?._mediaType || '').toLowerCase() === 'movie';
}

/**
 * Movie credit extraction is intentionally enabled only for Netflix for now.
 * Other providers keep their TV extraction active while their movie markers
 * are being verified against real playback.
 */
function movieCaptureAllowedForProvider(providerName) {
  return String(providerName || '').trim().toLowerCase() === 'netflix';
}

function providerCaptureAllowed(item, providerName) {
  return !isMovieSegment(item) || movieCaptureAllowedForProvider(providerName);
}

function capturedSegmentKey(item) {
  return JSON.stringify([String(item._showId || ''), String(item._eid), item.season, item.episode, item.segment_type, ...timestampRangeKey(item)]);
}

/** Reject missing/coerced values rather than turning null, blanks or booleans into zero. */
function timestampNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampRangeIssue(item, duration = item?._duration_sec) {
  const start = timestampNumber(item?.start_sec), end = timestampNumber(item?.end_sec);
  if (start === null || end === null || start < 0 || end <= start) return 'Invalid or missing timestamp boundaries';
  if (duration != null) {
    const limit = timestampNumber(duration);
    if (limit === null || limit <= 0 || end > limit) return 'Timestamp exceeds or has an invalid video duration';
  }
  return '';
}

function timestampRangeKey(item) {
  return [item?.start_sec, item?.end_sec].map(value => {
    const number = timestampNumber(value);
    return number === null ? null : Math.round(number * 1000);
  });
}

/** Only numeric timing evidence and fixed labels belong in recovery, never requests or tokens. */
function timestampEvidence({ provider, source, unit = 'seconds', rawStart, rawEnd, correction = 0 } = {}) {
  const providers = ['netflix', 'prime-video', 'videoland', 'skyshowtime', 'desktop'];
  const sources = ['provider-metadata', 'skip-marker', 'credits-offset', 'playback-event', 'chapter', 'catalogue-marker', 'visual-analysis', 'manual'];
  return {
    provider: providers.includes(provider) ? provider : 'unknown',
    source: sources.includes(source) ? source : 'provider-metadata',
    unit: unit === 'milliseconds' ? unit : 'seconds',
    raw_start: timestampNumber(rawStart), raw_end: timestampNumber(rawEnd),
    correction_sec: typeof correction === 'number' && Number.isFinite(correction) ? correction : 0,
  };
}

/** A manual observation has explicit identity, real boundaries and no provider offset. */
function validateManualIdentity({ imdbId, mediaType, season, episode, episodeTitle, segmentType }) {
  if (!/^tt\d{7,8}$/.test(imdbId || '')) throw new Error('Confirm a valid IMDb ID before marking timestamps.');
  if (!['tv', 'movie'].includes(mediaType)) throw new Error('Confirm the media type first.');
  if (!['intro', 'recap', 'outro'].includes(segmentType)) throw new Error('Choose Intro, Recap or Outro.');
  const movie = mediaType === 'movie';
  if (movie && segmentType !== 'outro') throw new Error('Online movie capture supports Outro only.');
  if (!movie && (![season, episode].every(value => Number.isInteger(value) && value > 0) || !String(episodeTitle || '').trim())) {
    throw new Error('Enter the playing episode’s season, episode number and actual title.');
  }
}

function createManualSegment({ provider, showId, imdbId, mediaType, season, episode, episodeTitle, segmentType, start, end, duration }) {
  validateManualIdentity({ imdbId, mediaType, season, episode, episodeTitle, segmentType });
  const movie = mediaType === 'movie';
  const item = {
    _eid: `manual:${movie ? 'movie' : `${season}:${episode}`}:${segmentType}`,
    _showId: String(showId || `manual:${imdbId}`), _episodeTitle: String(episodeTitle || '').trim(),
    _duration_sec: duration, _tvdbRequireTitleMatch: true,
    _tvdbEpisodeLanguages: provider === 'videoland' ? ['eng', 'nld'] : ['eng'],
    ...(movie ? { media_type: 'movie' } : {}), imdb_id: imdbId,
    season: movie ? null : season, episode: movie ? null : episode,
    segment_type: segmentType, start_sec: start, end_sec: end,
    _timing: timestampEvidence({ provider, source: 'manual', rawStart: start, rawEnd: end }),
  };
  if (!Number.isFinite(duration) || duration <= 0 || ![start, end].every(Number.isFinite) || !outputSegmentAllowed(item)) {
    throw new Error('Mark valid start and end points within this video: at least 5 seconds; movie outros at most 900 seconds.');
  }
  return item;
}

/** Compare candidates only after identity mapping. A changed candidate set invalidates a choice. */
function assessTimestampCandidates(items) {
  const groups = new Map(), decisions = new Map();
  for (const item of items) {
    const issue = timestampRangeIssue(item);
    if (issue) { decisions.set(item, { allowed: false, reason: issue }); continue; }
    const key = JSON.stringify([item.imdb_id || item._showId || '', isMovieSegment(item) ? 'movie' : [item.season, item.episode], normalizeIntrodbSegmentType(item.segment_type)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, group] of groups) {
    const variants = [...new Set(group.map(item => JSON.stringify(timestampRangeKey(item))))].sort();
    const signature = JSON.stringify([key, variants]);
    const chosen = new Set(group.filter(item => item._timingReview === signature).map(item => JSON.stringify(timestampRangeKey(item))));
    const selected = chosen.size === 1 ? [...chosen][0] : null;
    const seen = new Set();
    for (const item of group) {
      const range = JSON.stringify(timestampRangeKey(item));
      const conflict = variants.length > 1;
      const allowed = (!conflict || selected === range) && !seen.has(range);
      decisions.set(item, {
        allowed, conflict, signature,
        reason: allowed ? '' : conflict ? selected ? 'Alternative retained; another range was reviewed' : 'Conflicting timestamps: review the video and choose one range' : 'Repeated observation of the same range',
      });
      seen.add(range);
    }
  }
  return decisions;
}

function outputSegmentAllowed(item) {
  const movie = isMovieSegment(item);
  const start=Number(item?.start_sec),end=Number(item?.end_sec);
  return !timestampRangeIssue(item)&&['intro','recap','outro','post-credits'].includes(item.segment_type)&&end-start>=5&&(!movie||(['outro','post-credits'].includes(item.segment_type)&&end-start<=(item.segment_type==='outro'?900:600)));
}
function introdbPayload(item) {
  const movie = isMovieSegment(item);
  return {imdb_id:item.imdb_id,segment_type:item.segment_type,start_sec:item.start_sec,end_sec:item.end_sec,...(movie?{is_movie:true}:{season:item.season,episode:item.episode})};
}

/** IntroDB stores boundaries in milliseconds. */
function sameIntrodbRange(a, b) {
  return !timestampRangeIssue(a) && !timestampRangeIssue(b)
    && normalizeIntrodbSegmentType(a.segment_type) === normalizeIntrodbSegmentType(b.segment_type)
    && ['start_sec', 'end_sec'].every(key => a[key] != null && b[key] != null
      && Number.isFinite(Number(a[key])) && Number.isFinite(Number(b[key]))
      && Math.round(Number(a[key]) * 1000) === Math.round(Number(b[key]) * 1000));
}

function uploadSegmentKey(item) {
  return JSON.stringify([item.imdb_id, isMovieSegment(item) ? 'movie' : [item.season, item.episode],
    normalizeIntrodbSegmentType(item.segment_type), Math.round(Number(item.start_sec)*1000), Math.round(Number(item.end_sec)*1000)]);
}

/**
 * Normalize the segment names used by the public IntroDB response.
 * IntroDB documents post-credits with a hyphen in the wire format, while
 * older responses and clients may expose the underscore variant.
 */
function normalizeIntrodbSegmentType(segmentType) {
  const normalized = String(segmentType || '').trim().toLowerCase();
  if (normalized === 'credits') return 'outro';
  if (normalized === 'post_credits') return 'post-credits';
  return normalized;
}

function introdbSeconds(value) {
  const number = timestampNumber(value);
  if (number !== null) return number;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function introdbRangeValue(source, secondsKeys, millisecondsKey) {
  for (const key of secondsKeys) {
    if (source?.[key] != null) return introdbSeconds(source[key]);
  }
  if (source?.[millisecondsKey] != null) {
    const value = timestampNumber(source[millisecondsKey]);
    return value === null ? null : value / 1000;
  }
  return null;
}

/**
 * Parse the documented /segments response into displayable ranges.
 * Invalid ranges are retained separately so callers can block an upload
 * instead of silently treating malformed IntroDB data as an empty result.
 */
function parseIntrodbSegments(response) {
  if (response == null) return { types: new Set(), ranges: [], invalid: [] };
  if (typeof response !== 'object' || response.error || response.errors) {
    throw new Error('IntroDB returned an invalid response. Please try again.');
  }
  const documentedKeys = ['intro', 'recap', 'outro', 'credits', 'post_credits', 'post-credits'];
  const hasDocumentedShape = Array.isArray(response)
    || Array.isArray(response.segments)
    || documentedKeys.some(key => Object.prototype.hasOwnProperty.call(response, key));
  if (!hasDocumentedShape) {
    throw new Error('IntroDB returned an invalid response. Please try again.');
  }

  const types = new Set();
  const ranges = [];
  const invalid = [];
  const add = (segmentType, value) => {
    const normalizedType = normalizeIntrodbSegmentType(segmentType);
    if (!['intro', 'recap', 'outro', 'post-credits'].includes(normalizedType) || value == null) return;
    types.add(normalizedType);
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const source = entry?.segment && typeof entry.segment === 'object' ? entry.segment : entry;
      const start = introdbRangeValue(source, ['start_sec', 'startSec', 'start'], 'start_ms');
      const end = introdbRangeValue(source, ['end_sec', 'endSec', 'end'], 'end_ms');
      const range = {
        segment_type: normalizedType,
        start_sec: start,
        end_sec: end,
        credit_part: source?.credit_part ?? source?.creditPart ?? null,
      };
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) ranges.push(range);
      else invalid.push(range);
    }
  };

  if (Array.isArray(response)) {
    response.forEach(entry => add(entry?.segment_type || entry?.segmentType, entry));
  } else if (Array.isArray(response.segments)) {
    response.segments.forEach(entry => add(entry?.segment_type || entry?.segmentType, entry));
  }
  for (const type of ['intro', 'recap', 'outro', 'credits', 'post_credits', 'post-credits']) add(type, response[type]);
  return { types, ranges, invalid };
}

/** Return valid current IntroDB ranges in a UI/API-neutral shape. */
function introdbRangeEntries(response) {
  return parseIntrodbSegments(response).ranges;
}

/** Tab-scoped recovery across reloads. Credentials and network caches are excluded. */

let captureSessionKey = '';
let captureSaveTimer = null;
const CAPTURE_FIELDS = ['allItems', 'knownMovieScenes', 'showTitle', 'mediaType', 'showId', 'showYear', 'imdbId', 'imdbIdsByShowId', 'providerEpisodes', 'providerEpisodesByShowId', 'interceptedCount'];

function saveCaptureSession() {
  if (!captureSessionKey) return;
  clearTimeout(captureSaveTimer);
  captureSaveTimer = null;
  try {
    const data = Object.fromEntries(CAPTURE_FIELDS.map(key => [key, state[key]]));
    const savedAt = new Date().toISOString();
    sessionStorage.setItem(captureSessionKey, JSON.stringify({ version: 1, savedAt, data, showIds: [...state.showIds] }));
    state.sessionSavedAt = savedAt;
    state.sessionStorageError = false;
  } catch (_) {
    state.sessionStorageError = true;
  }
}

function scheduleCaptureSave() {
  if (!captureSessionKey || captureSaveTimer !== null) return;
  captureSaveTimer = setTimeout(saveCaptureSession, 500);
}

function restoreCaptureSession(providerName) {
  captureSessionKey = `segmentScraper.capture.v1.${providerName}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(captureSessionKey) || 'null');
    if (saved?.version !== 1 || !Array.isArray(saved.data?.allItems) || !Array.isArray(saved.showIds)) return false;
    if (!saved.data.allItems.every(item => item && typeof item === 'object' && !timestampRangeIssue(item))) return false;
    for (const key of CAPTURE_FIELDS) {
      if (Object.hasOwn(saved.data, key)) state[key] = saved.data[key];
    }
    state.showIds = new Set(saved.showIds);
    state.sessionSavedAt = saved.savedAt;
    state.dbSearchDone = false;
    return state.allItems.length > 0;
  } catch (_) {
    state.sessionStorageError = true;
    return false;
  }
}

function clearCaptureSession() {
  clearTimeout(captureSaveTimer);
  captureSaveTimer = null;
  try { sessionStorage.removeItem(captureSessionKey); } catch (_) { state.sessionStorageError = true; }
  state.sessionSavedAt = '';
}

/**
 * Required-update check for the generated userscript.
 * The version and install URL are injected by the bundler from package.json.
 */


const VERSION_CHECK_TIMEOUT_MS = 8000;
let updateCheckPromise = null;

function parseVersion(version) {
  const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;

    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return Number(left[index]) > Number(right[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

/** Compare two semantic versions. Returns 1 when left is newer, -1 when older. */
function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) return null;

  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] === right.numbers[index]) continue;
    return left.numbers[index] > right.numbers[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Read the userscript version from its metadata header. */
function extractUserscriptVersion(source) {
  return String(source || '').match(/^\s*\/\/\s*@version\s+([^\s]+)\s*$/m)?.[1] || null;
}

function requestRemoteUserscript(request) {
  return new Promise((resolve, reject) => {
    request({
      method: 'GET',
      url: `${SEGMENTSCRAPER_UPDATE_URL}?update-check=${Date.now()}`,
      timeout: VERSION_CHECK_TIMEOUT_MS,
      headers: { 'Cache-Control': 'no-cache' },
      onload: response => {
        if (response.status < 200 || response.status >= 300) {
          reject(new Error(`GitHub returned HTTP ${response.status}`));
          return;
        }
        resolve(response.responseText);
      },
      onerror: () => reject(new Error('GitHub request failed')),
      ontimeout: () => reject(new Error('GitHub request timed out')),
    });
  });
}

/**
 * Check GitHub once per page load. A failed check is fail-open; a confirmed newer
 * version is fail-closed and must be installed before normal use continues.
 */
function checkForRequiredUpdate(request = _GM_xmlhttpRequest) {
  if (updateCheckPromise) return updateCheckPromise;

  state.updateStatus = 'checking';
  state.currentVersion = SEGMENTSCRAPER_VERSION;
  state.updateUrl = SEGMENTSCRAPER_UPDATE_URL;

  updateCheckPromise = (async () => {
    if (typeof request !== 'function') {
      state.updateStatus = 'unavailable';
      return { required: false, status: state.updateStatus };
    }

    try {
      const source = await requestRemoteUserscript(request);
      const latestVersion = extractUserscriptVersion(source);
      const comparison = compareVersions(latestVersion, SEGMENTSCRAPER_VERSION);
      if (!latestVersion || comparison === null) throw new Error('GitHub version is invalid');

      state.latestVersion = latestVersion;
      state.updateRequired = comparison > 0;
      state.updateStatus = state.updateRequired ? 'required' : 'current';
      return { required: state.updateRequired, status: state.updateStatus, latestVersion };
    } catch (error) {
      state.updateStatus = 'unavailable';
      console.warn('[NFE] Update check unavailable; continuing with the installed version.', error);
      return { required: false, status: state.updateStatus, error };
    }
  })();

  return updateCheckPromise;
}

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

function filterImdbTitleResults(results, mediaType = 'tv') {
  const movieQids = new Set(['movie', 'tvmovie', 'videomovie', 'featurefilm', 'film', 'short', 'tvshort']);
  const allowedQids = String(mediaType).toLowerCase() === 'movie'
    ? movieQids
    : new Set(['tvseries', 'tvminiseries', 'tvshort', 'tvspecial']);
  return (results || []).filter(result => allowedQids.has(String(result?.qid || '').toLowerCase()));
}

function chooseImdbTitleResult(results, title, year) {
  const normalizedTitle = String(title || '').trim().toLowerCase();
  const normalizedYear = year == null ? '' : String(year);
  let best = results[0];
  if (normalizedYear) {
    const byYearAndTitle = results.find(result =>
      String(result?.y || '') === normalizedYear && String(result?.l || '').trim().toLowerCase() === normalizedTitle
    );
    const byYear = results.find(result => String(result?.y || '') === normalizedYear);
    if (byYearAndTitle) best = byYearAndTitle;
    else if (byYear) best = byYear;
  } else {
    const exact = results.find(result => String(result?.l || '').trim().toLowerCase() === normalizedTitle);
    if (exact) best = exact;
  }
  return best;
}

function resolveImdbSearchResponse(data, title, year, mediaType) {
  const results = filterImdbTitleResults(data?.d, mediaType);
  console.log(`[NFE] Filtered ${mediaType === 'movie' ? 'movie' : 'TV series'} results:`, results.length);
  if (!results.length) return { success: false, error: 'Not found on IMDb' };

  const best = chooseImdbTitleResult(results, title, year);
  const imdbId = best?.id;
  if (!imdbId || !String(imdbId).startsWith('tt')) {
    return { success: false, error: 'Could not obtain a valid IMDb ID' };
  }

  return {
    success: true,
    imdbId,
    title: best?.l || title,
    year: best?.y,
  };
}

/**
 * Search IMDb by title and return the best matching media ID.
 */
async function searchImdbByTitle(title, year, { mediaType = 'tv' } = {}) {
  const query = encodeURIComponent(String(title || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim());
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
            resolve(resolveImdbSearchResponse(data, title, year, mediaType));
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
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    console.log('[NFE] IMDb search response data:', data);
    return resolveImdbSearchResponse(data, title, year, mediaType);
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
  const mediaKeys = [...new Set(
    state.allItems
      .filter(i => i.imdb_id === imdbId)
      .map(i => createMediaCacheKey(imdbId, i.media_type || i.mediaType || i._mediaType, i.season, i.episode))
  )];

  console.log('[NFE-DEDUP] loadExistingSegments: unique media keys collected:', mediaKeys);

  // Load each episode's segments via /segments endpoint
  const results = await Promise.all(
    mediaKeys.map(key => loadExistingSegmentsForEpisode(key, apiKey))
  );

  // Return all segment types found
  const allSegments = [];
  for (let i = 0; i < mediaKeys.length; i++) {
    const key = mediaKeys[i];
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
  
  const [imdbId, seasonOrMediaType, episode] = key.split('|');
  const isMovie = seasonOrMediaType === 'movie';
  if (!isMovie && (!/^\d+$/.test(seasonOrMediaType || '') || Number(seasonOrMediaType) < 1
    || !/^\d+$/.test(episode || '') || Number(episode) < 1)) {
    throw new Error(`IntroDB cannot check ${imdbId} S${seasonOrMediaType}E${episode}: season and episode must be positive integers.`);
  }
  const describeHttpError = (status, body) => {
    let detail = '';
    try { const json = JSON.parse(body); detail = typeof json.error === 'string' ? json.error.slice(0, 200) : ''; } catch (_) {}
    return new Error(`IntroDB duplicate check returned HTTP ${status} for ${imdbId} S${seasonOrMediaType}E${episode}${detail ? `: ${detail}` : '.'}`);
  };
  const url = isMovie
    ? `${INTRODB_BASE}/segments?imdb_id=${encodeURIComponent(imdbId)}&is_movie=true`
    : `${INTRODB_BASE}/segments?imdb_id=${encodeURIComponent(imdbId)}&season=${encodeURIComponent(seasonOrMediaType)}&episode=${encodeURIComponent(episode)}`;
  
  const gmXhr = getGmXhr();

  const parseExistingSegments = json => {
    if (!json || typeof json !== 'object' || json.error || json.errors) {
      throw new Error('IntroDB returned an invalid response. Please try again.');
    }
    const parsed = parseIntrodbSegments(json);
    if (parsed.invalid.length) {
      throw new Error('IntroDB returned invalid timestamps. Please try again.');
    }
    const set = new Set(parsed.types);
    const rangesByType = new Map();
    for (const range of parsed.ranges) {
      const normalizedRange = {
        startSec: range.start_sec,
        endSec: range.end_sec,
        creditPart: range.credit_part,
      };
      rangesByType.set(range.segment_type, [...(rangesByType.get(range.segment_type) || []), normalizedRange]);
    }
    Object.defineProperty(set, 'rangesByType', { value: rangesByType, enumerable: false });
    return set;
  };
  
  return new Promise((resolve, reject) => {
    if (gmXhr) {
      gmXhr({
        method: 'GET',
        url: url,
        timeout: 15000,
        ontimeout: () => reject(new Error('IntroDB duplicate check timed out. Please try again.')),
        onabort: () => reject(new Error('IntroDB duplicate check was interrupted. Please try again.')),
        headers: { 'Accept': 'application/json' },
        onload: (response) => {
          try {
            if (response.status === 200) {
              const json = JSON.parse(response.responseText);
              const set = parseExistingSegments(json);
              if (writeCache) state.dedupCacheV2[key] = set;
              resolve(set);
            } else if (response.status === 404) {
              if (writeCache) state.dedupCacheV2[key] = new Set();
              resolve(new Set());
            } else {
              reject(describeHttpError(response.status, response.responseText));
            }
          } catch (_) {
            reject(new Error('IntroDB returned an invalid response. Please try again.'));
          }
        },
        onerror: () => {
          reject(new Error('IntroDB duplicate check failed. Please try again.'));
        }
      });
    } else {
      // Fallback to fetch (will likely fail due to CORS)
      fetch(url, { signal: AbortSignal.timeout(15000) })
        .then(async response => {
          if (response.status === 404) return {};
          if (!response.ok) throw describeHttpError(response.status, await response.text());
          return response.json();
        })
        .then(json => {
          const set = parseExistingSegments(json);
          if (writeCache) state.dedupCacheV2[key] = set;
          resolve(set);
        })
        .catch(reject);
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
  const data = introdbPayload(item);
  
  if (gmXhr) {
    return new Promise((resolve) => {
      gmXhr({
        method: 'POST',
        url: url,
        timeout: 15000,
        ontimeout: () => resolve({ success: false, status: 0 }),
        onabort: () => resolve({ success: false, status: 0 }),
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        data: JSON.stringify(data),
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
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(data),
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
      : await fetch(url, { signal: AbortSignal.timeout(15000) }).then(response => response.text());
    const result = (JSON.parse(responseText).d || []).find(item => item.id === imdbId);
    return result ? { success: true, title: result.l, year: result.y } : { success: false };
  } catch (_) {
    return { success: false };
  }
}

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

/** TMDB presence checks. Credentials stay in userscript storage, outside public state. */
const TMDB_TOKEN_STORAGE = 'segmentScraper.tmdb.token';
const tmdbSceneCache = new Map();

function saveTmdbToken(value) {
  if (typeof GM_setValue !== 'function') return false;
  try {
    GM_setValue(TMDB_TOKEN_STORAGE, String(value || '').trim().replace(/^Bearer\s+/i, ''));
    tmdbSceneCache.clear();
    return true;
  } catch (_) { return false; }
}

function tmdbRequest(path, token) {
  return new Promise(resolve => {
    const xhr = (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest)
      || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
    if (!xhr) { resolve(null); return; }
    try {
      xhr({ method: 'GET', url: `https://api.themoviedb.org/3${path}`,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 10000,
        onload: response => {
          try { resolve(response.status === 200 ? JSON.parse(response.responseText) : null); }
          catch (_) { resolve(null); }
        }, onerror: () => resolve(null), ontimeout: () => resolve(null), onabort: () => resolve(null),
      });
    } catch (_) { resolve(null); }
  });
}

async function checkTmdbExtraScenes(imdbId) {
  if (!/^tt\d+$/.test(String(imdbId))) return { status: 'unavailable', reason: 'Invalid IMDb ID' };
  let token = '';
  try { token = typeof GM_getValue === 'function' ? String(GM_getValue(TMDB_TOKEN_STORAGE, '') || '').trim() : ''; }
  catch (_) {}
  if (!token) return { status: 'unavailable', reason: 'Save your TMDB API Read Access Token first' };
  const cached = tmdbSceneCache.get(imdbId);
  if (cached && cached.expires > Date.now()) return cached.result;
  const found = await tmdbRequest(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`, token);
  if (!Array.isArray(found?.movie_results) || found.movie_results.length !== 1
    || !Number.isInteger(found.movie_results[0]?.id) || found.movie_results[0].id <= 0) {
    return { status: 'unavailable', reason: 'TMDB movie lookup failed or was ambiguous' };
  }
  const tmdbId = found.movie_results[0].id;
  const data = await tmdbRequest(`/movie/${tmdbId}/keywords`, token);
  if (!Array.isArray(data?.keywords) || data.keywords.some(keyword => typeof keyword?.name !== 'string')) {
    return { status: 'unavailable', reason: 'TMDB keyword check failed; verify token or retry' };
  }
  const keywords = data.keywords.map(keyword => String(keyword?.name || '').trim().toLowerCase())
    .filter(name => ['aftercreditsstinger', 'duringcreditsstinger'].includes(name));
  const result = { status: keywords.length ? 'present' : 'unknown', tmdbId, keywords };
  if (tmdbSceneCache.size >= 200) tmdbSceneCache.delete(tmdbSceneCache.keys().next().value);
  tmdbSceneCache.set(imdbId, { result, expires: Date.now() + 15 * 60 * 1000 });
  return result;
}

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
const GTST_IMDB_ID = 'tt0096597';
const TVDB_EPISODE_ENDPOINT_SHAPE = `${TVDB_BASE}/series/{seriesId}/episodes/{seasonType}/{language}?page={page}`;
let loginPromise = null;
const episodeListCache = new Map();
const episodeBaseCache = new Map();
const episodeTranslationCache = new Map();
const seriesExtendedCache = new Map();

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
    signal: AbortSignal.timeout(15000),
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

async function authenticatedTvdbGet(path, includeEnvelope = false) {
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
  return includeEnvelope ? response.body : response.body?.data;
}

// Follow every page: using only page zero can silently lose later seasons.
async function fetchAllTvdbEpisodes(basePath) {
  const episodes = [];
  for (let page = 0; page < 500; page++) {
    const envelope = await authenticatedTvdbGet(`${basePath}${basePath.includes('?') ? '&' : '?'}page=${page}`, true);
    const rows = envelope?.data?.series?.episodes || envelope?.data?.episodes;
    if (!Array.isArray(rows)) throw new Error('TVDB returned an invalid episode catalogue');
    episodes.push(...rows);
    if (envelope.links?.next == null) return episodes;
    if (!rows.length) throw new Error('TVDB pagination returned an empty page with a next link');
  }
  throw new Error('TVDB episode catalogue exceeded the pagination limit');
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
  const path = `/series/${encodedSeriesId}/episodes/${TVDB_SEASON_TYPE}/${encodedLanguage}`;
  if (!episodeListCache.has(cacheKey)) episodeListCache.set(cacheKey, fetchAllTvdbEpisodes(path).catch(error => { episodeListCache.delete(cacheKey); throw error; }));
  return episodeListCache.get(cacheKey);
}

async function fetchTvdbEpisodeTranslation(episodeId, language = TVDB_EPISODE_LANGUAGE) {
  const normalizedLanguage = String(language || TVDB_EPISODE_LANGUAGE).trim().toLowerCase();
  const cacheKey = `episode:${episodeId}|language:${normalizedLanguage}`;
  const path = `/episodes/${encodeURIComponent(episodeId)}/translations/${encodeURIComponent(normalizedLanguage)}`;
  return cachedTvdbGet(episodeTranslationCache, cacheKey, path);
}

async function fetchTvdbEpisodeBase(episodeId) {
  const cacheKey = `episode:${episodeId}|base`;
  const path = `/episodes/${encodeURIComponent(episodeId)}`;
  return cachedTvdbGet(episodeBaseCache, cacheKey, path);
}

async function fetchTvdbSeriesExtended(seriesId) {
  const encodedSeriesId = encodeURIComponent(seriesId);
  const cacheKey = `series:${seriesId}|extended`;
  const path = `/series/${encodedSeriesId}/extended`;
  return cachedTvdbGet(seriesExtendedCache, cacheKey, path);
}

async function fetchTvdbSeasonEpisodeList(seriesId, season) {
  const encodedSeriesId = encodeURIComponent(seriesId);
  const cacheKey = `series:${seriesId}|seasonType:${TVDB_SEASON_TYPE}|season:${season}|page:0`;
  const path = `/series/${encodedSeriesId}/episodes/${TVDB_SEASON_TYPE}?page=0&season=${encodeURIComponent(season)}`;
  const data = await cachedTvdbGet(episodeListCache, cacheKey, path);
  return data?.episodes || data?.series?.episodes || [];
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
    missingAbsoluteNumber: 'titles without an absolute episode number',
    absoluteEpisodeNotFound: 'absolute TVDB episodes not found',
    ambiguousAbsoluteEpisode: 'ambiguous absolute TVDB episodes',
    invalidCanonicalEpisode: 'TVDB episodes without canonical default numbering',
  };
  return Object.entries(reasons)
    .map(([reason, count]) => `${labels[reason] || reason}: ${count}`)
    .join(', ');
}

function extractAbsoluteEpisodeNumber(value) {
  const match = /^(?:aflevering|episode)\s+(\d+)$/.exec(normalizeTitle(value));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function extractEpisodeTitleNumber(value) {
  const match = /^(?:aflevering|episode)\s+(\d+)\b/.exec(normalizeTitle(value));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function getOfficialSeasonNumbers(series) {
  const seasons = Array.isArray(series?.seasons) ? series.seasons : [];
  const official = seasons.filter(season => {
    const typeId = Number(season?.type?.id ?? season?.typeId);
    const type = normalizeTitle(season?.type?.type || season?.type?.name || season?.typeName);
    return typeId === 1 || type === 'official' || type === 'aired order' || type === 'default';
  });
  const selected = official.length ? official : seasons;
  return [...new Set(selected
    .map(season => Number(season?.number))
    .filter(number => Number.isInteger(number) && number > 0))]
    .sort((a, b) => a - b);
}

async function findGtstEpisodeByTitleNumber(tvdbSeriesId, absoluteNumber) {
  const series = await fetchTvdbSeriesExtended(tvdbSeriesId);
  const seasons = getOfficialSeasonNumbers(series);
  let low = 0;
  let high = seasons.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const season = seasons[middle];
    const episodes = await fetchTvdbSeasonEpisodeList(tvdbSeriesId, season);
    const numberedEpisodes = episodes
      .map(episode => ({ episode, titleNumber: extractEpisodeTitleNumber(episode?.name) }))
      .filter(entry => entry.titleNumber != null)
      .sort((a, b) => a.titleNumber - b.titleNumber);
    if (!numberedEpisodes.length) return [];

    const first = numberedEpisodes[0].titleNumber;
    const last = numberedEpisodes[numberedEpisodes.length - 1].titleNumber;
    if (absoluteNumber < first) {
      high = middle - 1;
      continue;
    }
    if (absoluteNumber > last) {
      low = middle + 1;
      continue;
    }
    return numberedEpisodes
      .filter(entry => entry.titleNumber === absoluteNumber)
      .map(entry => entry.episode);
  }
  return [];
}

async function fetchTvdbEpisodeTitles(episode, languages) {
  const titles = [String(episode?.name || '').trim()].filter(Boolean);
  for (const language of languages) {
    try {
      const translation = await fetchTvdbEpisodeTranslation(episode.id, language);
      const title = String(translation?.name || '').trim();
      if (title && !titles.some(existing => normalizeTitle(existing) === normalizeTitle(title))) titles.push(title);
    } catch (error) {
      console.warn('[TVDB] GTST episode translation request failed', {
        episodeId: episode.id,
        requestedLanguage: language,
        reason: error?.message || String(error),
      });
    }
  }
  return titles;
}

async function mapGtstAbsoluteTitleEpisodes(providerEpisodes, tvdbSeriesId, languages) {
  const mapping = new Map();
  const skipReasons = {};
  const usedTvdbIds = new Set();

  for (const providerEpisode of providerEpisodes) {
    const absoluteNumber = extractAbsoluteEpisodeNumber(providerEpisode.title);
    if (absoluteNumber == null) {
      incrementReason(skipReasons, 'missingAbsoluteNumber');
      continue;
    }

    const absoluteMatches = await findGtstEpisodeByTitleNumber(tvdbSeriesId, absoluteNumber);
    if (!absoluteMatches.length) {
      incrementReason(skipReasons, 'absoluteEpisodeNotFound');
      continue;
    }
    if (absoluteMatches.length !== 1) {
      incrementReason(skipReasons, 'ambiguousAbsoluteEpisode');
      continue;
    }

    const absoluteEpisode = absoluteMatches[0];
    if (absoluteEpisode?.id == null) {
      incrementReason(skipReasons, 'absoluteEpisodeNotFound');
      continue;
    }
    const canonicalEpisode = await fetchTvdbEpisodeBase(absoluteEpisode.id);
    const canonicalSeason = Number(canonicalEpisode?.seasonNumber);
    const canonicalNumber = Number(canonicalEpisode?.number);
    if (!Number.isInteger(canonicalSeason) || canonicalSeason < 1 ||
        !Number.isInteger(canonicalNumber) || canonicalNumber < 1) {
      incrementReason(skipReasons, 'invalidCanonicalEpisode');
      continue;
    }

    const titles = await fetchTvdbEpisodeTitles(
      { ...canonicalEpisode, name: absoluteEpisode.name || canonicalEpisode.name },
      languages,
    );
    const providerTitle = normalizeTitle(providerEpisode.title);
    const exactTitles = titles.filter(title =>
      extractAbsoluteEpisodeNumber(title) === absoluteNumber &&
      normalizeTitle(title) === providerTitle
    );
    if (!exactTitles.length) {
      incrementReason(skipReasons, 'noExactMatch');
      continue;
    }
    if (usedTvdbIds.has(String(canonicalEpisode.id))) {
      incrementReason(skipReasons, 'reusedTvdbEpisode');
      continue;
    }

    usedTvdbIds.add(String(canonicalEpisode.id));
    mapping.set(`${providerEpisode.season}|${providerEpisode.episode}`, {
      id: canonicalEpisode.id,
      season: canonicalSeason,
      episode: canonicalNumber,
      title: exactTitles[0],
    });
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
      method: 'absolute-title',
      reason: `no reliable GTST absolute-number and exact-title mappings exist${reasonSummary ? ` (${reasonSummary})` : ''}`,
      matchStats,
    };
  }
  return {
    success: true,
    mapping,
    method: 'absolute-title',
    reason: `GTST absolute-number lookup with exact title verification; ${mapping.size} matched and ${matchStats.skipped} skipped${reasonSummary ? ` (${reasonSummary})` : ''}`,
    matchStats,
  };
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
    const episodeLanguages = [...new Set(items.flatMap(item =>
      Array.isArray(item._tvdbEpisodeLanguages) ? item._tvdbEpisodeLanguages : []
    ).map(language => String(language || '').trim().toLowerCase()))]
      .filter(Boolean);
    // GTST always uses absolute numbering, including captures restored from older releases.
    const useGtstAbsoluteTitleMatch = imdbId === GTST_IMDB_ID;

    let result;
    let tvdbEpisodes = [];
    let tvdbSpecialsExcluded = 0;
    if (useGtstAbsoluteTitleMatch) {
      result = await mapGtstAbsoluteTitleEpisodes(
        providerEpisodes,
        tvdbSeriesId,
        [...new Set([TVDB_EPISODE_LANGUAGE, ...episodeLanguages])],
      );
    } else {
      const episodeList = await fetchTvdbEpisodeList(tvdbSeriesId, TVDB_EPISODE_LANGUAGE);
      const localizedEpisodes = await ensureTvdbEpisodeNameLanguage(episodeList, providerEpisodes, TVDB_EPISODE_LANGUAGE);
      logTvdbEpisodeLanguageAudit(tvdbSeriesId, TVDB_EPISODE_LANGUAGE, episodeList, localizedEpisodes);
      const tvdbCatalog = cleanTvdbEpisodes(localizedEpisodes);
      tvdbEpisodes = tvdbCatalog.episodes;
      tvdbSpecialsExcluded = tvdbCatalog.specialsExcluded;
      if (requireTitleMatch || providerEpisodes.length !== tvdbEpisodes.length) {
        const additionalLanguages = episodeLanguages
          .filter(language => language !== TVDB_EPISODE_LANGUAGE);
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
      result = mapEpisodes(providerEpisodes, tvdbEpisodes, { requireTitleMatch });
    }
    const stats = {
      providerRegular: providerEpisodes.length,
      tvdbRegular: useGtstAbsoluteTitleMatch ? result.matchStats?.matched ?? 0 : tvdbEpisodes.length,
      providerSpecialsExcluded,
      tvdbSpecialsExcluded,
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
      const {
        _eid,
        _episodeTitle,
        _showId,
        _tvdbEpisodeLanguages,
        _tvdbRequireTitleMatch,
        _tvdbAbsoluteTitleMatch,
        ...submissionItem
      } = item;
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
  textSecondary: '#b0b0b0',
  textMuted: '#999',
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
    captureHint: 'TV series and Netflix movie credits are captured automatically. Other provider movie credits remain disabled while their markers are verified.',
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
    captureHint: 'Series segments are captured automatically. Movie credits are temporarily disabled while provider markers are verified.',
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
    captureHint: 'Series segments are fetched per episode. Movie credits are temporarily disabled while provider markers are verified.',
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
    captureHint: 'Series segments are captured automatically. Movie credits are temporarily disabled while provider markers are verified.',
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
    captureHint: 'Series segments are fetched per episode. Movie credits are temporarily disabled while provider markers are verified.',
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
    captureHint: 'Series segments are captured automatically from SkyShowtime catalogue metadata. Movie credits are temporarily disabled while provider markers are verified.',
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
  POST_CREDITS: 'post-credits',
};

/**
 * Build a full movie outro plus an optional, explicitly timed extra scene.
 * A credits marker after a known scene cannot identify the full outro.
 */
function splitCreditRange({
  startSec,
  endSec,
  runtimeSec = null,
  afterCreditsStartSec = null,
  afterCreditsEndSec = null,
  afterCreditsDetected = false,
}) {
  const start = startSec == null ? NaN : Number(startSec);
  const end = runtimeSec == null ? Number(endSec) : Number(runtimeSec);
  if (endSec == null && runtimeSec == null) return [];
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return [];
  const sceneStart = afterCreditsStartSec == null ? null : Number(afterCreditsStartSec);
  const sceneEnd = afterCreditsEndSec == null ? null : Number(afterCreditsEndSec);
  const hasScene = afterCreditsDetected || sceneStart !== null || sceneEnd !== null;
  // A partial scene must not leave an apparently safe standalone outro.
  if (hasScene && !Number.isFinite(sceneEnd)) return [];
  if (hasScene && (!Number.isFinite(sceneStart) || sceneStart <= start || sceneStart >= end)) return [];
  if (Number.isFinite(sceneEnd) && (sceneEnd <= sceneStart || sceneEnd > end)) return [];
  const parts = [{ startSec: start, endSec: end, creditPart: null }];
  // Runtime is an outro boundary only, never a substitute for the scene end.
  if (hasScene && Number.isFinite(sceneEnd)) {
    parts.push({ startSec: sceneStart, endSec: sceneEnd, segmentType: SEGMENT_TYPES.POST_CREDITS, creditPart: null });
  }
  return parts;
}

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
 * @param {string} [params.mediaType] - Media type, currently `tv` or `movie`
 * @param {string} [params.creditPart] - Movie credit part around an after-credits scene
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
  episodeTitle = '',
  mediaType = 'tv',
  creditPart = null,
  timing = null,
  durationSec = null,
}) {
  const segmentType = normalizeSegmentType(providerSegmentType, providerName);
  if (!segmentType) return null;
  
  return {
    _eid: episodeId,
    _episodeTitle: episodeTitle,
    ...(timing ? { _timing: timing } : {}),
    ...(durationSec != null ? { _duration_sec: durationSec } : {}),
    ...(showId ? { _showId: String(showId) } : {}),
    ...(String(mediaType).toLowerCase() === 'movie' ? { media_type: 'movie' } : {}),
    ...(creditPart ? { credit_part: creditPart } : {}),
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
  mediaType = 'tv',
  season,
  episode,
  episodeTitle = '',
  providerIdLabel = 'providerId',
  providerId = '',
  items = [],
}) {
  if (!items.length) return;

  const episodeLabel = String(mediaType).toLowerCase() === 'movie'
    ? 'MOVIE'
    : `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const details = {
    title: episodeTitle || '',
    ...(providerId != null && providerId !== '' ? { [providerIdLabel]: providerId } : {}),
    segments: items.map(item => ({
      type: item.segment_type,
      ...(item.credit_part ? { credit_part: item.credit_part } : {}),
      start: formatCapturedTimestamp(item.start_sec),
      end: formatCapturedTimestamp(item.end_sec),
      start_sec: item.start_sec,
      end_sec: item.end_sec,
    })),
  };
  // Keep capture logs in the normal Console log stream. Some DevTools setups
  // hide the Info level by default, which made the timestamps look missing
  // even though Prime had captured them successfully.
  const writeLog = typeof console !== 'undefined' && typeof console.log === 'function'
    ? console.log.bind(console)
    : console.info.bind(console);
  const times = details.segments.map(segment => `${segment.type}: ${segment.start} → ${segment.end}`).join(' · ');
  writeLog(`[${prefix}] Captured timestamps · ${showTitle || 'Unknown series'} · ${episodeLabel} · ${times}`, details);
}

/**
 * Shared UI panel component
 * Creates a reusable panel with provider-configurable styling
 */


// Default provider name
let currentProvider = 'netflix';
let panelReturnFocus = null;

/**
 * Set the current provider name
 */
function setProviderName(name) {
  currentProvider = name;
}

function bindPanelCallback(element, callbackName, logMessage) {
  if (!element) return;
  element.addEventListener('click', () => {
    if (logMessage) console.log(logMessage);
    if (window.nfePanelCallbacks && window.nfePanelCallbacks[callbackName]) {
      window.nfePanelCallbacks[callbackName]();
    }
  });
}

function bindButtonClickOnEnter(input, getButton) {
  if (!input) return;
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const button = getButton();
    if (button) button.click();
  });
}

function setupPanelEventListeners() {
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

  bindPanelCallback(closeBtn, 'onClose', '[NFE] Close button clicked');
  bindPanelCallback(exportBtn, 'onExport', '[NFE] Export button clicked');
  bindPanelCallback(document.getElementById('nfe-diagnostics'), 'onDiagnostics');
  bindPanelCallback(submitBtn, 'onSubmit', '[NFE] Submit button clicked');
  bindPanelCallback(clearBtn, 'onClear', '[NFE] Clear button clicked');
  bindPanelCallback(imdbSetBtn, 'onImdbSet', '[NFE] IMDB set button clicked');
  bindPanelCallback(imdbSearchBtn, 'onImdbSearch', '[NFE] IMDB search button clicked');
  bindButtonClickOnEnter(imdbInput, () => document.getElementById('nfe-imdb-set'));

  bindPanelCallback(apikeySetBtn, 'onApikeySet', '[NFE] API key set button clicked');
  bindButtonClickOnEnter(apikeyInput, () => document.getElementById('nfe-apikey-set'));

  bindPanelCallback(tvdbSetBtn, 'onTvdbSet');
  bindPanelCallback(document.getElementById('nfe-tmdb-set'), 'onTmdbSet');
  bindButtonClickOnEnter(document.getElementById('nfe-tmdb-input'), () => document.getElementById('nfe-tmdb-set'));
  tvdbInputs.filter(Boolean).forEach(input => bindButtonClickOnEnter(input, () => tvdbSetBtn));
  for (const [id, callback] of [['start','onManualStart'],['end','onManualEnd'],['preview-start','onManualPreviewStart'],['preview-end','onManualPreviewEnd'],['save','onManualSave'],['reset','onManualReset']]) {
    bindPanelCallback(document.getElementById(`nfe-manual-${id}`), callback);
  }
  for (const id of ['media','type','season','episode','title']) {
    document.getElementById(`nfe-manual-${id}`)?.addEventListener('change', () => {
      const fields = document.getElementById('nfe-manual-episode-fields');
      if (fields) fields.hidden = document.getElementById('nfe-manual-media').value === 'movie';
      window.nfePanelCallbacks?.onManualReset?.();
    });
  }
}

function updateManualCapture({ start, end, message }) {
  for (const [key, value] of [['start', start], ['end', end]]) {
    const label = document.getElementById(`nfe-manual-${key}-value`);
    if (label) label.textContent = Number.isFinite(value) ? `${value.toFixed(3)} s` : 'Not marked';
    const preview = document.getElementById(`nfe-manual-preview-${key}`);
    if (preview) preview.disabled = !Number.isFinite(value);
  }
  const save = document.getElementById('nfe-manual-save');
  if (save) save.disabled = !Number.isFinite(start) || !Number.isFinite(end);
  const review = document.getElementById('nfe-manual-reviewed');
  if (review) review.checked = false;
  const status = document.getElementById('nfe-manual-status');
  if (status) status.textContent = message || '';
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
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'SegmentScraper');
  panel.tabIndex = -1;
  panel.style.cssText = `
    position:fixed; z-index:2147483647; width:308px; max-width:calc(100vw - 40px);
    background:${colors.background}; border:1px solid ${colors.border}; border-radius:12px;
    padding:16px; color:${colors.text}; font-family:-apple-system,Arial,sans-serif;
    font-size:13px; line-height:normal; box-sizing:border-box; box-shadow:0 16px 48px rgba(0,0,0,0.85);
    transition:opacity 0.18s; user-select:none; display:none; opacity:0;
    max-height:calc(100dvh - 40px); overflow:auto; overscroll-behavior:contain;
    scrollbar-width:thin; scrollbar-color:#555 #181818;
  `;

  if (state.updateRequired) {
    panel.innerHTML = `
      <style>
        #nfe-panel, #nfe-panel * { box-sizing:border-box; font-family:-apple-system,Arial,sans-serif; text-shadow:none; }
      </style>
      <div style="font-size:15px;font-weight:800;color:#ff6b6b;margin-bottom:10px">Update required</div>
      <div style="background:${colors.panelBg};border:1px solid #7f3030;border-radius:9px;padding:12px;margin-bottom:10px;color:${colors.textSecondary};font-size:12px;line-height:1.5">
        A newer SegmentScraper version is available. Version <strong style="color:${colors.text}">${state.latestVersion}</strong>
        must be installed before you can continue.
      </div>
      <a id="nfe-update-link" href="${state.updateUrl}" target="_blank" rel="noopener noreferrer"
        style="display:block;width:100%;background:#d83b3b;border-radius:8px;color:#fff;padding:11px;text-align:center;text-decoration:none;font-size:13px;font-weight:800">
        Update to v${state.latestVersion}
      </a>
      <div style="font-size:10px;color:${colors.textMuted};margin-top:9px;line-height:1.4;text-align:center">
        Installed: v${state.currentVersion}. Confirm the installation and then reload this page.
      </div>
    `;

    (document.fullscreenElement || document.body).appendChild(panel);
    panel.addEventListener('click', event => event.stopPropagation());
    panel.addEventListener('mousedown', event => event.stopPropagation());
    console.warn(`[NFE] Update required: v${state.currentVersion} -> v${state.latestVersion}`);
    return;
  }

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
      #nfe-panel :focus-visible { outline:2px solid white; outline-offset:2px; }
      #nfe-panel summary { cursor:pointer; padding:8px 0; font-size:12px; font-weight:700; }
      #nfe-manual { background:${colors.panelBg}; border-radius:9px; padding:4px 10px 10px; margin-bottom:10px; }
      #nfe-manual label { display:block; font-size:11px; margin:7px 0; color:${colors.textSecondary}; }
      #nfe-manual input:not([type="checkbox"]), #nfe-manual select { width:100%; min-width:0; margin-top:4px; padding:6px; background:#242424; color:#fff; border:1px solid #444; border-radius:5px; font:12px Arial,sans-serif; }
      #nfe-manual button { flex:1; padding:7px 5px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; cursor:pointer; font:12px Arial,sans-serif; }
      #nfe-manual button:disabled { opacity:.45; cursor:default; }
      #nfe-manual input[type="checkbox"] { appearance:auto; -webkit-appearance:auto; }
      #nfe-manual [hidden] { display:none!important; }
    </style>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700;color:${nameColor}">${config.name} ${branding.title}</span>
      <button id="nfe-close" aria-label="Close SegmentScraper" style="background:none;border:none;color:${colors.textMuted};font-size:18px;cursor:pointer;line-height:1;padding:0;transition:color 0.15s"
        onmouseenter="this.style.color='${colors.text}'" onmouseleave="this.style.color='${colors.textMuted}'">✕</button>
    </div>

    <div id="nfe-title-display" style="color:${colors.textSecondary};font-size:11px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:13px"></div>

    <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
      <div id="nfe-imdb-status" style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:7px">${state.mediaType === 'movie' ? 'Movie' : 'TV'} · IMDb ID: ${state.imdbId || 'Not set'}</div>
      <div style="display:flex;gap:4px">
        <input id="nfe-imdb-input" aria-label="IMDb ID or search title" type="text" placeholder="ID (e.g. tt123456)..." value="${state.imdbId}"
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

    <div id="nfe-imdb-feedback" role="status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:8px;line-height:1.4"></div>
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

    <details id="nfe-manual" open><summary>Mark timestamps from video</summary>
      <div style="font-size:11px;line-height:1.4;color:${colors.textSecondary}">Confirm the IMDb title above and the playing episode below. Each mark pauses the video.</div>
      <div style="display:flex;gap:6px">
        <label style="flex:1">Media<select id="nfe-manual-media"><option value="tv" ${state.mediaType === 'movie' ? '' : 'selected'}>TV episode</option><option value="movie" ${state.mediaType === 'movie' ? 'selected' : ''}>Movie</option></select></label>
        <label style="flex:1">Segment type<select id="nfe-manual-type"><option value="intro">Intro</option><option value="recap">Recap</option><option value="outro" ${state.mediaType === 'movie' ? 'selected' : ''}>Outro</option></select></label>
      </div>
      <div id="nfe-manual-episode-fields" ${state.mediaType === 'movie' ? 'hidden' : ''}>
        <div style="display:flex;gap:6px"><label style="flex:1">Season<input id="nfe-manual-season" type="number" min="1" step="1" placeholder="1"></label><label style="flex:1">Episode<input id="nfe-manual-episode" type="number" min="1" step="1" placeholder="1"></label></div>
        <label>Episode title<input id="nfe-manual-title" type="text" placeholder="Actual episode title for TVDB matching"></label>
      </div>
      <div style="display:flex;gap:6px"><button id="nfe-manual-start">Start here</button><button id="nfe-manual-end">End here</button></div>
      <div style="display:flex;justify-content:space-between;margin:6px 0;font:11px monospace"><span>Start: <output id="nfe-manual-start-value">Not marked</output></span><span>End: <output id="nfe-manual-end-value">Not marked</output></span></div>
      <div style="display:flex;gap:6px"><button id="nfe-manual-preview-start" disabled>Preview start</button><button id="nfe-manual-preview-end" disabled>Preview end</button></div>
      <label><input id="nfe-manual-reviewed" type="checkbox"> I checked this title/episode and both boundaries.</label>
      <div style="display:flex;gap:6px"><button id="nfe-manual-save" disabled>Save segment</button><button id="nfe-manual-reset">Reset marks</button></div>
      <div id="nfe-manual-status" role="status" style="font-size:11px;line-height:1.4;margin-top:7px">Choose Intro, Recap or Outro. Saving keeps a local candidate; uploading requires separate approval.</div>
    </details>

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
      Show timestamps
    </button>
    ${currentProvider === 'skyshowtime' ? `<button id="nfe-diagnostics" style="width:100%;padding:8px;margin-bottom:6px;border:1px solid ${colors.border};border-radius:8px;background:${colors.panelBg};color:#fff;cursor:pointer">Download movie diagnostics</button><div style="font-size:11px;color:${colors.textMuted};margin-bottom:8px">Very short movie credits are held for review. Missing scene markers do not confirm that there is no extra scene.</div>` : ''}

     <details id="nfe-settings"><summary>API settings</summary>
     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">TVDB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">Your TVDB API Key</div>
       <input id="nfe-tvdb-apikey-input" aria-label="TheTVDB API key" type="password" placeholder="Enter your TVDB API key..."
         style="width:100%;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                padding:6px 8px;font-size:12px;outline:none;margin-bottom:5px"/>
       <div style="display:flex;gap:4px">
         <input id="nfe-tvdb-pin-input" aria-label="TheTVDB subscriber PIN" type="password" placeholder="Subscriber PIN (optional)"
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
         <input id="nfe-apikey-input" aria-label="IntroDB API key" type="password" placeholder="Enter your IntroDB API key..."
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
           onfocus="this.style.borderColor='${colors.accent}'" onblur="this.style.borderColor='#303030'"/>
         <button id="nfe-apikey-set"
           style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
           onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">Save</button>
       </div>
     </div>

     <div style="display:flex;align-items:center;gap:6px;margin:8px 0"><div style="flex:1;height:1px;background:#222"></div><span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">TMDB</span><div style="flex:1;height:1px;background:#222"></div></div>
     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px;font-size:11px;line-height:1.4;color:${colors.textSecondary}">
       <label for="nfe-tmdb-input">TMDB API Read Access Token (movie scene check)</label>
       <div style="display:flex;gap:4px;margin:5px 0">
         <input id="nfe-tmdb-input" type="password" autocomplete="off" placeholder="Paste token; blank clears it"
           style="min-width:0;flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;padding:6px 8px"/>
         <button id="nfe-tmdb-set" style="background:${providerColors.primary};border:0;border-radius:6px;color:#fff;padding:6px 10px;cursor:pointer">Save</button>
       </div>
       <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" style="color:${colors.textSecondary}">Get a TMDB token</a> · Saved locally. Movie export/upload requires a successful check. Missing keywords do not prove scene absence.
       <div>This product uses the TMDB API but is not endorsed or certified by TMDB.</div>
     </div>
     </details>
     <div id="nfe-session-status" role="status" style="font-size:11px;color:#aaa;margin:8px 0;line-height:1.4"></div>
     <div id="nfe-introdb-status" role="status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:6px;line-height:1.4;text-align:center;${state.introdbApiKey ? '' : 'display:none;'}">${state.introdbApiKey ? 'API key saved locally' : ''}</div>
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

  setupPanelEventListeners();
  const feedback = document.getElementById('nfe-imdb-feedback');
  if (feedback) feedback.textContent = state.dbStatusMsg || '';

  panel.addEventListener('click', e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
  });
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
  panelReturnFocus = document.activeElement;
  positionPanel(panel);
  panel.style.pointerEvents = 'auto';
  document.getElementById('nfe-btn')?.setAttribute('aria-expanded', 'true');
  state.panelVisible = true;
  panel.style.display = 'block';
  panel.focus();
  requestAnimationFrame(() => (panel.style.opacity = '1'));
  updateCounters();
  updatePanelTitle();
}

/**
 * Close the panel
 */
function closePanel() {
  if (state.updateRequired) return;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  state.panelVisible = false;
  document.getElementById('nfe-btn')?.setAttribute('aria-expanded', 'false');
  if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';
  setTimeout(() => {
    if (!state.panelVisible) {
      panel.style.display = 'none';
      panel.style.pointerEvents = 'auto';
    }
  }, 200);
}

/** Replace an existing panel with the non-dismissible required-update screen. */
function showRequiredUpdate() {
  document.getElementById('nfe-panel')?.remove();
  state.panelVisible = false;
  openPanel();
}

/**
 * Update counter displays
 */
function updateCounters() {
  const $ = id => document.getElementById(id);
  const session = $('nfe-session-status');
  if (session) session.textContent = state.sessionStorageError
    ? 'Session recovery is unavailable. Download your data before reloading.'
    : state.sessionSavedAt ? 'Session saved in this tab: ' + new Date(state.sessionSavedAt).toLocaleString('en-GB') : 'Captured data is saved in this tab for recovery after reload.';
  const ts = $('nfe-cnt-ts');
  if (ts) ts.textContent = state.allItems.length;
  const segmentsLabel = $('nfe-cnt-segments-label');
  if (segmentsLabel) segmentsLabel.textContent = state.allItems.length === 1 ? 'Segment' : 'Segments';
  
  const rq = $('nfe-cnt-req');
  if (rq) rq.textContent = state.showIds.size;
  const mediaLabel = $('nfe-cnt-series-label');
  if (mediaLabel) {
    const hasMovie = state.allItems.some(item => String(item?.media_type || item?.mediaType || item?._mediaType || '').toLowerCase() === 'movie');
    mediaLabel.textContent = hasMovie ? 'Media' : 'Series';
  }
  
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
  t.setAttribute('role', 'status');
  (document.fullscreenElement || document.body).appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

/**
 * Show the export data in a modal before files are downloaded.
 * The preview deliberately uses textContent so captured metadata cannot inject HTML.
 */
function showExportPreview(view) {
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
  heading.textContent = view.mode === 'submit' ? 'Review IntroDB upload' : `${providerName} timestamps`;
  heading.style.cssText = `margin:0 0 6px; color:${providerColors.primary}; font:700 16px/normal -apple-system,Arial,sans-serif;`;
  const summary = document.createElement('p');
  summary.style.cssText = `margin:0 0 12px; color:${colors.textSecondary}; font:13px/normal -apple-system,Arial,sans-serif;`;
  const preview = document.createElement('div');
  preview.style.cssText = `
    overflow:auto; flex:1; min-height:180px; margin:0 0 14px; padding:12px; border-radius:8px;
    background:${colors.panelBg}; color:${colors.text}; box-sizing:border-box;
    font:11px/normal ui-monospace,Consolas,monospace; white-space:pre-wrap;
  `;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
  const cancel = document.createElement('button');
  cancel.textContent = 'Close';
  cancel.style.cssText = 'box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; font:13px/normal -apple-system,Arial,sans-serif; cursor:pointer;';
  const confirm = document.createElement('button');
  confirm.textContent = view.mode === 'submit' ? 'Upload to IntroDB' : 'Download JSON';
  confirm.style.cssText = `box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; font:700 13px/normal -apple-system,Arial,sans-serif; cursor:pointer;`;
  const upload = document.createElement('button');
  upload.textContent = 'Upload to IntroDB';
  upload.style.cssText = `box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:0; border-radius:6px; background:${providerColors.primary}; color:#fff; font:700 13px/normal -apple-system,Arial,sans-serif; cursor:pointer;`;

  const clock = value => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const ms = Math.round(Number(value) * 1000);
    const seconds = Math.floor(ms / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const humanClock = value => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return `${Number(value).toFixed(3)} s`;
  };
  const rangeText = range => {
    const start = range?.start_sec ?? range?.startSec;
    const end = range?.end_sec ?? range?.endSec;
    return `${clock(start)} → ${clock(end)}\n${humanClock(start)} → ${humanClock(end)}`;
  };
  const mediaIsMovie = item => item?.is_movie === true || String(item?.media_type || item?.mediaType || item?._mediaType || '').toLowerCase() === 'movie';
  const makeColumn = (title, ranges, emptyText, accent) => {
    const column = document.createElement('div');
    column.style.cssText = `min-width:0; padding:10px; border:1px solid ${colors.border}; border-radius:8px; background:${colors.background};`;
    const heading = document.createElement('strong');
    heading.textContent = title;
    heading.style.cssText = `display:block; margin-bottom:7px; color:${accent}; font:700 12px/normal -apple-system,Arial,sans-serif;`;
    column.append(heading);
    if (!ranges.length) {
      const empty = document.createElement('div');
      empty.textContent = emptyText;
      empty.style.cssText = `color:${colors.textMuted}; font:11px/1.45 -apple-system,Arial,sans-serif;`;
      column.append(empty);
      return column;
    }
    for (const range of ranges) {
      const type = document.createElement('div');
      type.textContent = range.segment_type || 'timestamp';
      type.style.cssText = 'margin-bottom:3px; color:#fff; font-weight:700;';
      const times = document.createElement('div');
      times.textContent = rangeText(range);
      times.style.cssText = 'white-space:pre-line; color:#ddd; line-height:1.55;';
      column.append(type, times);
    }
    return column;
  };
  const approvedKeys = new Set();
  const approvalInputs = new Map();
  let typeFilter = 'all';
  const matchesFilter = item => typeFilter === 'all' || item.segment_type === typeFilter;
  const exportSelection = () => (view.items || []).filter(matchesFilter);
  const candidates = () => {
    const allowed = new Set((view.rows || []).filter(row => row.status === 'NEW').map(row => uploadSegmentKey(row.canonical || row.item)));
    return (view.mode === 'submit' ? (view.items || []) : (view.uploadItems || [])).filter(item => matchesFilter(item) && allowed.has(uploadSegmentKey(item)));
  };
  const selected = () => candidates().filter(item => approvedKeys.has(uploadSegmentKey(item)));
  const approvalControl = (text, items) => {
    const label = document.createElement('label'), input = document.createElement('input');
    const controlKey = JSON.stringify([text, items.map(uploadSegmentKey)]);
    approvalInputs.set(controlKey, input);
    input.type = 'checkbox';
    input.checked = items.length > 0 && items.every(item => approvedKeys.has(uploadSegmentKey(item)));
    input.indeterminate = !input.checked && items.some(item => approvedKeys.has(uploadSegmentKey(item)));
    input.disabled = !items.length || Boolean(view.checking);
    label.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 0;font:12px/1.5 Arial,sans-serif;';
    input.addEventListener('change', () => {
      for (const item of items) { const key = uploadSegmentKey(item); if(input.checked) approvedKeys.add(key); else approvedKeys.delete(key); }
      update(view);
      approvalInputs.get(controlKey)?.focus();
    });
    label.append(input, document.createTextNode(text));
    return label;
  };
  const update = next => {
    view = next;
    const allRows = view.rows || [];
    const rows = allRows.filter(row => matchesFilter(row.item));
    summary.textContent = `${rows.length} of ${allRows.length} timestamps · ${rows.filter(row => row.status === 'NEW').length} NEW · ${rows.filter(row => row.status === 'In IntroDB').length} in IntroDB · ${rows.filter(row => row.status === 'Unavailable').length} unavailable. ${view.message || ''}`;
    const filterLabel = document.createElement('label'), filter = document.createElement('select');
    filterLabel.textContent = 'Segment filter: ';
    filterLabel.style.cssText = 'display:block;margin-top:10px;font:12px Arial,sans-serif;';
    filter.setAttribute('aria-label', 'Filter timestamps by segment type');
    filter.style.cssText = 'background:#242424;color:#fff;border:1px solid #555;border-radius:5px;padding:6px;font:12px Arial,sans-serif;';
    for (const [value, label] of [['all','All'],['intro','Intro'],['recap','Recap'],['outro','Outro'],['post-credits','Extra scenes']]) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = `${label} (${allRows.filter(row => value === 'all' || row.item.segment_type === value).length})`;
      filter.append(option);
    }
    filter.value = typeFilter;
    filter.addEventListener('change', () => { typeFilter = filter.value; approvedKeys.clear(); update(view); summary.querySelector?.('select')?.focus(); });
    filterLabel.append(filter, document.createTextNode(' · Export and approval apply to the visible type.'));
    summary.append(filterLabel);
    preview.replaceChildren();
    approvalInputs.clear();
    const eligible = candidates();
    const eligibleKeys = new Set(eligible.map(uploadSegmentKey));
    for(const key of approvedKeys) if(!eligibleKeys.has(key)) approvedKeys.delete(key);
    if(eligible.length) preview.append(approvalControl('Approve all visible eligible timestamps after video and IntroDB comparison', eligible));
    const groups = new Set();
    for (const row of rows) {
      const item = row.item;
      const canonical = row.canonical || item;
      const groupKey = `${canonical.imdb_id}|${mediaIsMovie(canonical)}`;
      if(eligible.length && !groups.has(groupKey)) {
        groups.add(groupKey);
        const group = eligible.filter(value => `${value.imdb_id}|${mediaIsMovie(value)}` === groupKey);
        if(group.length) preview.append(approvalControl(`Approve ${mediaIsMovie(canonical) ? 'movie' : 'series'} ${canonical.imdb_id}`, group));
      }
      const entry = document.createElement('div');
      entry.style.cssText = `padding:10px 0; border-bottom:1px solid ${colors.border}; line-height:1.6;`;
      const label = document.createElement('strong');
      label.textContent = row.status;
      label.style.color = row.status === 'NEW' ? '#69d89b' : colors.textSecondary;
      const meta = document.createElement('div');
      const movie = mediaIsMovie(item);
      const itemLabel = movie ? 'Movie' : item.season != null && item.episode != null ? `S${item.season}E${item.episode}` : 'TV episode';
      meta.textContent = `${item.imdb_id || 'IMDb pending'} · ${itemLabel}${item._episodeTitle ? ` · ${item._episodeTitle}` : ''}`;
      const canonicalSeason = row.canonical?.season;
      const canonicalEpisode = row.canonical?.episode;
      if (!movie && canonicalSeason != null && canonicalEpisode != null) meta.textContent += ` · TVDB S${canonicalSeason}E${canonicalEpisode}`;
      if (row.reason) meta.textContent += `\n${row.reason}`;
      if (item._timing) {
        const evidence = item._timing;
        const divisor = evidence.unit === 'milliseconds' ? 1000 : 1;
        meta.textContent += `\nSource: ${evidence.provider} / ${evidence.source} · raw ${evidence.raw_start ?? 'unknown'} → ${evidence.raw_end ?? 'unknown'} ${evidence.unit}`;
        if (evidence.correction_sec) meta.textContent += `\nStart correction: ${evidence.correction_sec} s · original ${clock(evidence.raw_start / divisor)}`;
      }
      meta.style.cssText = 'margin-top:4px; white-space:pre-line; color:#ddd; font:11px/1.5 ui-monospace,Consolas,monospace;';
      const currentRanges = row.existingSegments
        ? row.existingSegments.filter(matchesFilter)
        : (row.existingRanges || []).map(range => ({ segment_type: item.segment_type, start_sec: range.startSec, end_sec: range.endSec }));
      const comparison = document.createElement('div');
      comparison.style.cssText = 'display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:9px;';
      comparison.append(
        makeColumn('Scraper', [{ segment_type: item.segment_type, start_sec: item.start_sec, end_sec: item.end_sec }], 'No scraper timestamp', providerColors.primary),
        makeColumn('IntroDB', currentRanges, row.existingSegments ? 'No current timestamp returned' : 'IntroDB check unavailable', '#e4b968'),
      );
      entry.append(label, meta, comparison);
      if(eligibleKeys.has(uploadSegmentKey(canonical)) && row.status !== 'In IntroDB' && row.status !== 'Unavailable') {
        entry.append(approvalControl('I checked this timestamp against the video and IntroDB and approve its upload', [canonical]));
      }
      if (row.onChoose && !view.checking) {
        const choose = document.createElement('button');
        choose.textContent = 'Use this range after video review';
        choose.style.cssText = cancel.style.cssText;
        choose.addEventListener('click', () => { close(false); row.onChoose(); });
        entry.append(choose);
      }
      preview.append(entry);
    }
    confirm.hidden = typeof view.onConfirm !== 'function';
    confirm.disabled = Boolean(view.checking || !exportSelection().length || typeof view.onConfirm !== 'function' || (view.mode === 'submit' && !selected().length));
    confirm.style.opacity = confirm.disabled ? '.45' : '1';
    confirm.style.cursor = confirm.disabled ? 'not-allowed' : 'pointer';
    confirm.textContent = view.checking
      ? 'Checking…'
      : view.mode === 'submit' ? `Upload to IntroDB (${selected().length})` : `Download JSON (${exportSelection().length} timestamps)`;
    upload.hidden = typeof view.onUpload !== 'function';
    upload.disabled = Boolean(view.checking || !selected().length || !view.onUpload);
    upload.style.opacity = upload.disabled ? '.45' : '1';
    upload.style.cursor = upload.disabled ? 'not-allowed' : 'pointer';
    upload.textContent = `Upload to IntroDB (${selected().length})`;
  };
  update(view);

  const previousFocus = document.activeElement;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Show timestamps');
  const close = (cancelled = true) => {
    if (!overlay.isConnected) return;
    overlay.remove();
    if (cancelled && view.onCancel) view.onCancel();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const focusables = [...dialog.querySelectorAll('input,button,select')].filter(button => !button.hidden && !button.disabled);
      const currentIndex = focusables.indexOf(document.activeElement);
      focusables[(currentIndex + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length]?.focus();
    }
  });
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  confirm.addEventListener('click', () => { if (!confirm.disabled) { const onConfirm = view.onConfirm; close(false); onConfirm(selected(), exportSelection()); } });
  upload.addEventListener('click', () => { if (!upload.disabled) { const onUpload = view.onUpload; close(false); onUpload(selected()); } });
  actions.append(cancel, confirm, upload);
  dialog.append(heading, summary, preview, actions);
  overlay.append(dialog);
  overlay.addEventListener('click', event => event.stopPropagation());
  (document.fullscreenElement || document.body).append(overlay);
  cancel.focus();
  return update;
}

/** Mount the extractor as a native control-row item, never inside a play-button wrapper. */

const PLAYER_CONTROL_ANCHORS = {
  netflix: ['[data-uia="control-fullscreen-enter"]', '[data-uia="control-fullscreen-exit"]', '[data-uia="control-audio-subtitle"]', '[data-uia="control-play-pause-play"]', '[data-uia="control-play-pause-pause"]'],
  'prime-video': ['.atvwebplayersdk-fullscreen-button', '.atvwebplayersdk-subtitles-button', '.atvwebplayersdk-playpause-button'],
  videoland: ['.vjs-fullscreen-control', '.vjs-play-control', '[data-testid="fullscreen-button"]', '[data-testid="play-pause-button"]'],
  skyshowtime: ['[data-testid="fullscreen-button"]', '[data-testid="player-fullscreen-button"]', '.vjs-fullscreen-control', '[data-testid="play-pause-button"]'],
  crunchyroll: ['[data-testid="fullscreen-button"]', '[data-testid="vilos-fullscreen-button"]', '[data-testid="play-pause-button"]', '.vjs-fullscreen-control'],
};

// These anchors were verified against supplied player markup. Their structural
// identity remains valid while the provider hides its controls.
const VERIFIED_CONTROL_ANCHORS = {
  'prime-video': '#atvwebplayersdk-skip-backward-button',
  videoland: '#volume-bar-control',
  skyshowtime: '[data-testid="playback-lower-controls"] [data-testid="language-settings-button"]',
};
let mountedPlayerControl = null;

function getNextEpBtn(providerName) {
  const root = document.fullscreenElement || document;
  const verifiedSelector = VERIFIED_CONTROL_ANCHORS[providerName];
  if (verifiedSelector) {
    const verified = root.querySelector(verifiedSelector);

    if (verified) return verified;
  }
  const videos = [...root.querySelectorAll('video')].map(video => video.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
  const isPlaybackControl = anchor => {
    if (!anchor || !anchor.matches('button, [role="button"]') || anchor.closest('[role="slider"], .vjs-progress-control, [data-uia="timeline"]')) return false;
    const rect = anchor.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return videos.some(video => rect.top >= video.top + video.height / 2 && rect.top <= video.bottom + 60 && rect.left >= video.left && rect.right <= video.right + 1);
  };
  for (const selector of PLAYER_CONTROL_ANCHORS[providerName] || []) {
    for (const candidate of root.querySelectorAll(selector)) {
      const anchor = candidate.matches('button, [role="button"]') ? candidate : candidate.querySelector('button, [role="button"]');
      if (isPlaybackControl(anchor)) return anchor;
    }
  }
  for (const anchor of root.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label]')) {
    const label = anchor.getAttribute('aria-label') || anchor.title || '';
    if (/^(play|pause|afspelen|pauzeren)(?:$|\s|\()/i.test(label.trim()) && isPlaybackControl(anchor)) return anchor;
  }
  return null;
}

/** Pure structural decision; wrapped native controls receive a sibling slot. */
function getControlMount(providerName, anchor) {
  const parent = anchor.parentElement;
  if (providerName === 'videoland' && anchor.id === 'volume-bar-control') {
    // Reserve space beside the entire volume/fullscreen group. Do not enlarge a
    // fixed-size fullscreen wrapper or depend on its changing translated label.
    return { reference: parent.parentElement, wrapped: true, after: false };
  }
  if (providerName === 'skyshowtime' && anchor.getAttribute('data-testid') === 'language-settings-button') {
    return { reference: anchor, wrapped: false, after: true };
  }
  if (providerName === 'prime-video' && anchor.id === 'atvwebplayersdk-skip-backward-button') {
    return { reference: parent, wrapped: true, after: false };
  }
  // Lift past single-control wrappers until reaching a row containing other
  // native controls. Inserting inside a fixed fullscreen wrapper stacks buttons.
  let reference = anchor;
  for (let container = parent; container && !container.matches?.('body, html'); container = container.parentElement) {
    const count = container.querySelectorAll?.('button:not(#nfe-btn), [role="button"]:not(#nfe-btn)').length;
    if (count > 1) return { reference, wrapped: reference !== anchor, after: false };
    if (count == null) break;
    reference = container;
  }
  return { reference: anchor, wrapped: false, after: false };
}

function removePlayerButton() {
  document.getElementById('nfe-button-slot')?.remove();
  document.getElementById('nfe-btn')?.remove();
  mountedPlayerControl = null;
}

function injectBtn(providerName, getAnchor = getNextEpBtn) {
  if (!document.body) return;
  let button = document.getElementById('nfe-btn');
  let anchor = getAnchor(providerName);
  const root = document.fullscreenElement || document;
  if (!anchor && mountedPlayerControl?.providerName === providerName &&
      mountedPlayerControl.anchor.isConnected && root.contains(mountedPlayerControl.anchor)) {
    // Zero-sized/hidden controls are not evidence that the player was removed.
    anchor = mountedPlayerControl.anchor;
  }
  if (!anchor) { removePlayerButton(); return; }
  if (!button) {
    button = document.createElement('button');
    button.id = 'nfe-btn';
    button.type = 'button';
    button.title = 'Open SegmentScraper';
    button.setAttribute('aria-label', 'Open SegmentScraper');
    button.setAttribute('aria-controls', 'nfe-panel');
    button.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'display:block!important;width:28px!important;height:28px!important;pointer-events:none!important;';
    // Provider SVG rules must not turn the filmstrip into a filled square.
    const shadow = icon.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host{color:white}svg{display:block;width:28px;height:28px;fill:none}</style><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="20" height="14" rx="1.5" stroke="white" stroke-width="1.6" fill="none"/><path d="M6 5v14M18 5v14M2 9h4m12 0h4M2 15h4m12 0h4" stroke="white" stroke-width="1.4" fill="none"/><polyline points="9,10 12,13.5 15,10" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M12 8v5.5" stroke="white" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
    button.appendChild(icon);
    button.addEventListener('click', event => {
      event.stopPropagation();
      event.preventDefault();
      togglePanel();
    });
    button.addEventListener('keydown', event => event.stopPropagation());
  }
  const { reference, after } = getControlMount(providerName, anchor);
  button.dataset.placement = 'controls';
  button.className = '';
  const rect = anchor.getBoundingClientRect();
  const height = rect.height > 0 ? Math.max(40, Math.min(64, rect.height)) : 40;
  const buttonStyle = 'all:initial;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;width:40px!important;min-width:40px!important;height:' + height + 'px!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important;color:white!important;cursor:pointer!important;flex:0 0 40px!important;position:static!important;transform:none!important;';
  if (button.dataset.controlHeight !== String(height)) {
    button.dataset.controlHeight = String(height);
    button.style.cssText = buttonStyle;
  }
  let slot = document.getElementById('nfe-button-slot');
  if (!slot) {
    slot = document.createElement('span');
    slot.id = 'nfe-button-slot';
    slot.style.cssText = 'all:initial;box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;align-self:center!important;vertical-align:middle!important;flex:0 0 48px!important;width:48px!important;min-width:48px!important;margin:0 4px!important;padding:0!important;position:static!important;';
  }
  if (button.parentElement !== slot) slot.appendChild(button);
  const correctlyPlaced = after ? reference.nextElementSibling === slot : slot.nextElementSibling === reference;
  if (slot.parentElement !== reference.parentElement || !correctlyPlaced) reference.insertAdjacentElement(after ? 'afterend' : 'beforebegin', slot);
  if (providerName === 'netflix') {
    // Netflix's SVG can sit above the button's box center. Match the visible
    // native icon, including its responsive size, rather than the wrapper.
    const nativeIcon = anchor.querySelector('svg')?.getBoundingClientRect();
    if (nativeIcon?.width > 0 && nativeIcon.height > 0) {
      const size = Math.max(32, Math.min(48, nativeIcon.width));
      const box = button.getBoundingClientRect();
      const offset = nativeIcon.top + nativeIcon.height / 2 - box.top - box.height / 2;
      const appearance = size + ':' + offset;
      if (button.dataset.netflixIcon !== appearance) {
        const icon = button.firstElementChild;
        icon.style.cssText = 'display:block!important;flex-shrink:0!important;width:' + size + 'px!important;height:' + size + 'px!important;pointer-events:none!important;transform:translateY(' + offset + 'px)!important;';
        icon.shadowRoot.querySelector('svg').style.cssText = 'width:100%;height:100%;';
        button.dataset.netflixIcon = appearance;
      }
    }
  }
  mountedPlayerControl = { providerName, anchor };
  if (!document.getElementById('nfe-button-style')) {
    const style = document.createElement('style');
    style.id = 'nfe-button-style';
    style.textContent = '#nfe-btn:focus-visible{outline:2px solid white!important;outline-offset:2px}';
    (document.head || document.body).appendChild(style);
  }
}

/** Transient player bindings never enter session storage or exports. */
function createManualCapture({ getContext, record, render, findVideo = findManualCaptureVideo }) {
  let draft = null, video = null, source = '', contextKey = '', frame = null, frameRequest = null, previewStop = null;
  const publish = message => render({ start: draft?.start ?? null, end: draft?.end ?? null, message });
  const stopPreview = () => {
    if (previewStop) {
      previewStop.video.removeEventListener('timeupdate', previewStop.listener);
      if (previewStop.video.currentSrc === previewStop.source) previewStop.video.pause();
    }
    previewStop = null;
  };
  const reset = (message = 'Choose the segment type, then pause at each boundary and mark it.') => {
    stopPreview();
    if (video) {
      video.removeEventListener('emptied', changed);
      video.removeEventListener('loadstart', changed);
      if (frameRequest != null) video.cancelVideoFrameCallback?.(frameRequest);
    }
    draft = null; video = null; frame = null; frameRequest = null;
    publish(message);
  };
  const changed = () => reset('Video changed. Confirm the playing title/episode and mark both boundaries again.');
  const bind = current => {
    video = current;
    source = video.currentSrc;
    video.addEventListener('emptied', changed);
    video.addEventListener('loadstart', changed);
    const observe = (_, metadata) => {
      if (video !== current) return;
      frame = { time: metadata.mediaTime, clock: current.currentTime };
      frameRequest = current.requestVideoFrameCallback(observe);
    };
    if (typeof video.requestVideoFrameCallback === 'function') frameRequest = video.requestVideoFrameCallback(observe);
  };
  const current = () => {
    const context = getContext();
    const key = JSON.stringify(context);
    const found = findVideo();
    if (!found || !Number.isFinite(found.duration) || found.duration <= 0 || !Number.isFinite(found.currentTime) || found.seeking) {
      throw new Error('Wait for one visible video to load and finish seeking. Multiple visible videos cannot be marked safely.');
    }
    if (draft && (video !== found || source !== found.currentSrc || contextKey !== key || draft.duration !== found.duration)) {
      changed(); throw new Error('Video or episode changed. Mark the start again.');
    }
    if (!draft && video && (video !== found || source !== found.currentSrc || contextKey !== key)) reset();
    if (!video) { bind(found); contextKey = key; }
    return context;
  };
  const mark = which => {
    const context = current();
    if (which === 'end' && !draft) throw new Error('Mark the start first.');
    stopPreview();
    video.pause();
    // A fresh displayed-frame time is useful; after a seek use the media clock.
    const time = frame && Math.abs(frame.clock - video.currentTime) < 0.05 && Math.abs(frame.time - video.currentTime) < 0.2 ? frame.time : video.currentTime;
    if (which === 'start') draft = { ...context, start: time, end: null, duration: video.duration };
    else draft.end = time;
    publish(which === 'start' ? 'Start marked. Play or seek to the end, then choose End here.' : 'End marked. Preview both boundaries, then save the reviewed segment.');
  };
  const preview = which => {
    current();
    const time = draft?.[which];
    if (!Number.isFinite(time)) throw new Error(`Mark the ${which} first.`);
    stopPreview();
    const currentVideo = video, end = Math.min(video.duration, time + 2);
    const pending = { video: currentVideo, source: currentVideo.currentSrc, listener: null };
    pending.listener = () => { if (previewStop === pending && currentVideo.currentTime >= end) stopPreview(); };
    previewStop = pending;
    const failed = () => {
      // An old play() rejection must not cancel a newer preview or show a stale error.
      if (previewStop !== pending) return;
      stopPreview();
      throw new Error('Use the player’s Play button to preview this boundary.');
    };
    try {
      currentVideo.pause();
      currentVideo.currentTime = Math.max(0, time - 2);
      currentVideo.addEventListener('timeupdate', pending.listener);
      return Promise.resolve(currentVideo.play()).catch(failed);
    } catch (_) { return failed(); }
  };
  const save = reviewed => {
    current();
    if (!reviewed) throw new Error('Confirm that you checked the title/episode and both boundaries.');
    if (!draft) throw new Error('Mark both boundaries first.');
    const item = createManualSegment(draft);
    record(item);
    reset(`Saved ${item.segment_type}: ${item.start_sec.toFixed(3)}–${item.end_sec.toFixed(3)} s. Open Show timestamps to review/export.`);
    return item;
  };
  return { mark, preview, save, reset };
}

function findManualCaptureVideo() {
  const root = document.fullscreenElement || document;
  const candidates = root.matches?.('video') ? [root] : [...root.querySelectorAll('video')];
  const visible = candidates.filter(video => {
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= window.innerHeight || rect.left >= window.innerWidth || video.readyState < 2) return false;
    for (let element = video; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  });
  return visible.length === 1 ? visible[0] : null;
}

/**
 * Shared provider bootstrap and control flow.
 * The Netflix UI/controls are the single source of truth for every provider.
 */



let activeProviderConfig = getProviderConfig('netflix');
let activeProviderName = 'netflix';
const introdbChecksInFlight = new Map();
const acceptedUploadKeys = new Set();
let manualCapture = null;


function getItemShowId(item) {
  return item?._showId != null ? String(item._showId) : '';
}

function getItemMediaType(item) {
  return String(item?.media_type || item?.mediaType || item?._mediaType || 'tv').toLowerCase() === 'movie'
    ? 'movie'
    : 'tv';
}

function isMovieItem(item) {
  return getItemMediaType(item) === 'movie';
}

function getItemCacheKey(item) {
  return createMediaCacheKey(item.imdb_id, getItemMediaType(item), item.season, item.episode);
}

function existingSegmentsForDisplay(existing) {
  const rangesByType = existing?.rangesByType;
  if (!rangesByType?.entries) return [];
  const segments = [];
  for (const [segmentType, ranges] of rangesByType.entries()) {
    for (const range of ranges || []) {
      segments.push({
        segment_type: segmentType,
        start_sec: Number(range.startSec),
        end_sec: Number(range.endSec),
        credit_part: range.creditPart ?? null,
      });
    }
  }
  return segments;
}

function ensureIntrodbSegments(items) {
  const keys = [...new Set((items || [])
    .filter(item => item?.imdb_id && item.imdb_id !== 'IMDB_PENDING')
    .map(getItemCacheKey))];
  for (const key of keys) {
    if (state.dedupCacheV2[key] || introdbChecksInFlight.has(key)) continue;
    const promise = loadExistingSegmentsForEpisode(key)
      .then(existing => {
        const count = existing?.rangesByType ? existingSegmentsForDisplay(existing).length : 0;
        if (count) setIntrodbStatus(`IntroDB timestamps loaded for the current item (${count}). Compare them with the Scraper result in Show timestamps.`);
        return existing;
      })
      .catch(error => {
        console.warn('[NFE-DEDUP] Could not load current IntroDB timestamps:', error);
        setIntrodbStatus(error.message);
        return null;
      })
      .finally(() => introdbChecksInFlight.delete(key));
    introdbChecksInFlight.set(key, promise);
  }
}

function loadCurrentIntrodbSegments(imdbId) {
  return loadExistingSegments(imdbId).then(segments => {
    const currentItems = state.allItems.filter(item => item.imdb_id === imdbId);
    if (currentItems.length && segments.length) {
      setIntrodbStatus(`IntroDB timestamps loaded for ${currentItems.length} captured item${currentItems.length === 1 ? '' : 's'}. Compare them with the Scraper result in Show timestamps.`);
    }
    ensureIntrodbSegments(currentItems);
    return segments;
  });
}

function hasTvItems(items) {
  return items.some(item => !isMovieItem(item));
}

// Temporary policy: exclude the entire movie when an extra scene is known.
// Missing provider/IntroDB markers are unknown, not evidence of scene absence.
async function filterMoviesWithKnownExtraScenes(items, existingByKey) {
  const excluded = new Set();
  for (const item of [...state.allItems, ...items]) {
    if (isMovieItem(item) && item.segment_type === 'post-credits') excluded.add(getItemCacheKey(item));
    if (isMovieItem(item) && (state.knownMovieScenes || []).some(scene =>
      (scene.showId && scene.showId === getItemShowId(item)) || (scene.imdbId && scene.imdbId === item.imdb_id))) excluded.add(getItemCacheKey(item));
  }
  for (const item of items) {
    if (!isMovieItem(item)) continue;
    const key = getItemCacheKey(item);
    const existing = existingByKey.get(key);
    if (existing?.has?.('post-credits') || existing?.rangesByType?.get('post-credits')?.length) excluded.add(key);
  }
  const movieIds = [...new Set(items.filter(isMovieItem).filter(item => !excluded.has(getItemCacheKey(item))).map(item => item.imdb_id))];
  const tmdbResults = new Map();
  if (movieIds.length) toast(`Checking TMDB for extra scenes (${movieIds.length} movie(s))...`);
  for (const id of movieIds) tmdbResults.set(id, await checkTmdbExtraScenes(id));
  const notified = new Set();
  return items.filter(item => {
    if (!isMovieItem(item)) return true;
    const key = getItemCacheKey(item);
    const tmdb = tmdbResults.get(item.imdb_id);
    const knownScene = excluded.has(key) || tmdb?.status === 'present';
    if (!knownScene && tmdb?.status === 'unknown') return true;
    if (!notified.has(key)) {
      toast(knownScene
        ? `Movie ${item.imdb_id}: extra scene detected${tmdb?.status === 'present' ? ' by TMDB' : ''}; entire movie temporarily excluded.`
        : `Movie ${item.imdb_id}: ${tmdb?.reason || 'TMDB check unavailable'}; export and upload withheld.`);
      notified.add(key);
    }
    return false;
  });
}

function applyImdbIdToShow(imdbId, showId, { overwrite = false } = {}) {
  scheduleCaptureSave();
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
  const feedback = document.getElementById('nfe-imdb-feedback');
  if (feedback) feedback.textContent = msg;
  const el = document.getElementById('nfe-imdb-status');
  if (el) el.textContent = `${state.mediaType === 'movie' ? 'Movie' : 'TV'} · IMDb ID: ${state.imdbId || 'Not set'}`;
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
function handleDetectedShow({ title, showId = null, year = '', imdbOverride = null, mediaType = 'tv' }) {
  if (state.updateRequired) return;
  const normalizedShowId = showId != null ? String(showId) : null;
  const normalizedMediaType = String(mediaType).toLowerCase() === 'movie' ? 'movie' : 'tv';
  const showChanged = Boolean(title) && (
    title !== state.showTitle ||
    (normalizedShowId && normalizedShowId !== state.showId) ||
    normalizedMediaType !== (state.mediaType || 'tv')
  );
  if (showChanged) {
    manualCapture?.reset('Title changed. Confirm the playing title/episode and mark both boundaries again.');
    const manualMedia = document.getElementById('nfe-manual-media');
    if (manualMedia) manualMedia.value = normalizedMediaType;
    const manualFields = document.getElementById('nfe-manual-episode-fields');
    if (manualFields) manualFields.hidden = normalizedMediaType === 'movie';
    if (normalizedMediaType === 'movie' && document.getElementById('nfe-manual-type')) document.getElementById('nfe-manual-type').value = 'outro';
    for (const key of ['season', 'episode', 'title']) {
      const input = document.getElementById(`nfe-manual-${key}`); if (input) input.value = '';
    }
    state.showTitle = title;
    state.mediaType = normalizedMediaType;
    state.showId = normalizedShowId;
    if (state.showId) state.showIds.add(state.showId);
    state.showYear = year ? String(year) : '';
    state.dbSearchDone = false;
    state.imdbId = '';
    state.dedupCacheV2 = {};
    state.providerEpisodes = [];
    updateImdbInput();
    setDbStatus(`Detected ${normalizedMediaType === 'movie' ? 'movie' : 'TV series'}; looking up IMDb...`);
    setTvdbStatus(normalizedMediaType === 'movie'
      ? 'TVDB is not needed for movies'
      : (state.tvdbApiKey ? 'TVDB credentials saved locally' : ''));
    updatePanelTitle();
  }

  if (normalizedMediaType === 'movie' && !movieCaptureAllowedForProvider(activeProviderName)) {
    state.dbSearchDone = true;
    setDbStatus(`${activeProviderConfig.name} movie credit capture is temporarily disabled; TV series capture remains active.`);
    setTvdbStatus('Movie capture is temporarily disabled');
    updateCounters();
    return;
  }

  if (state.dbSearchDone || !state.showTitle) return;
  state.dbSearchDone = true;

  const lookupTitle = state.showTitle;
  const lookupYear = state.showYear;
  const lookupShowId = state.showId;
  const lookupMediaType = state.mediaType || 'tv';
  const isCurrentShow = () => lookupShowId
    ? state.showId === lookupShowId && (state.mediaType || 'tv') === lookupMediaType
    : state.showTitle === lookupTitle && (state.mediaType || 'tv') === lookupMediaType;

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
    loadCurrentIntrodbSegments(imdbOverride).catch(error => setIntrodbStatus(error.message));
    return;
  }

  searchImdbByTitle(lookupTitle, lookupYear, { mediaType: lookupMediaType }).then(result => {
    if (result.success) {
      console.info('[NFE] IMDb media resolved:', {
        mediaType: lookupMediaType,
        title: lookupTitle,
        imdbId: result.imdbId,
      });
      applyImdbIdToShow(result.imdbId, lookupShowId);
      if (!isCurrentShow()) return;
      state.imdbId = result.imdbId;
      updateImdbInput();
      setDbStatus(`Found: ${result.imdbId}`);
      updateCounters();
      loadCurrentIntrodbSegments(result.imdbId).catch(error => setIntrodbStatus(error.message));
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

function removeDisabledMovieCaptures(providerName) {
  if (movieCaptureAllowedForProvider(providerName)) return 0;
  const retained = state.allItems.filter(item => providerCaptureAllowed(item, providerName));
  const removed = state.allItems.length - retained.length;
  if (!removed) return 0;
  state.allItems = retained;
  scheduleCaptureSave();
  updateCounters();
  console.info(`[NFE] Removed ${removed} movie capture(s); movie credits are temporarily disabled for ${activeProviderConfig.name}.`);
  return removed;
}

/** Store extractor output and update the shared counters/toast identically. */
function recordExtractedSegments(items, providerName = activeProviderName) {
  if (state.updateRequired) return;
  if (!Array.isArray(items) || !items.length) return;
  const receivedCount = items.length;
  items = items.filter(item => providerCaptureAllowed(item, providerName));
  if (items.length !== receivedCount) {
    const providerLabel = activeProviderConfig?.name || providerName;
    console.info(`[NFE] Skipped ${receivedCount - items.length} movie capture(s); movie credits are temporarily disabled for ${providerLabel}.`);
    setDbStatus(`${providerLabel} movie credits are temporarily disabled; TV segments remain active.`);
  }
  if (!items.length) return;
  // An incomplete scene is still evidence of its presence, even though its
  // timestamps cannot be accepted. Keep that evidence across capture/reload.
  for (const item of items) {
    if (!isMovieItem(item) || item.segment_type !== 'post-credits') continue;
    const scene = { showId: getItemShowId(item), imdbId: item.imdb_id && item.imdb_id !== 'IMDB_PENDING' ? item.imdb_id : '' };
    if (!scene.showId && !scene.imdbId) continue;
    state.knownMovieScenes ||= [];
    if (!state.knownMovieScenes.some(value => value.showId === scene.showId && value.imdbId === scene.imdbId)) {
      state.knownMovieScenes.push(scene);
      scheduleCaptureSave();
    }
  }
  const invalid = items.filter(item => timestampRangeIssue(item));
  if (invalid.length) {
    toast(`${invalid.length} invalid timestamp(s) ignored. Check provider boundaries and runtime.`);
    console.warn('[NFE] Rejected invalid provider timestamps:', invalid.map(item => ({ type: item?.segment_type, reason: timestampRangeIssue(item) })));
  }
  items = items.filter(item => !timestampRangeIssue(item)).map(item => {
    const evidence = item._timing;
    return { ...item, start_sec: Number(item.start_sec), end_sec: Number(item.end_sec), _timing: timestampEvidence({
      provider: evidence?.provider || providerName, source: evidence?.source,
      unit: evidence?.unit, rawStart: evidence ? evidence.raw_start : item.start_sec,
      rawEnd: evidence ? evidence.raw_end : item.end_sec, correction: evidence?.correction_sec,
    }) };
  });
  const keys = new Set(state.allItems.map(capturedSegmentKey));
  items = items.filter(item => {
    const key = capturedSegmentKey(item);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (!items.length) return;
  state.allItems.push(...items);
  scheduleCaptureSave();
  state.interceptedCount++;
  updateCounters();
  ensureIntrodbSegments(items);
  toast(`+${items.length} timestamps captured · total: ${state.allItems.length}`);
}

function isAlreadyInIntroDB(item) {
  const key = getItemCacheKey(item);
  return hasExistingSegment(state.dedupCacheV2[key], item);
}

function hasExistingSegment(existing, item) {
  if (acceptedUploadKeys.has(uploadSegmentKey(item))) return true;
  if (!existing) return false;
  const ranges = existing.rangesByType?.get(item.segment_type);
  if (ranges?.length) {
    return ranges.some(range => sameIntrodbRange(item, { segment_type: item.segment_type, start_sec: range.startSec, end_sec: range.endSec }));
  }
  return existing.has?.(item.segment_type) ?? false;
}

const overviewSource = Symbol('overviewSource');

function captureSnapshot() {
  return JSON.stringify([state.allItems.map(item => [capturedSegmentKey(item), item.imdb_id, item._timingReview || '', item._duration_sec]), state.knownMovieScenes || []]);
}

function captureStillCurrent(snapshot) {
  if (snapshot === captureSnapshot()) return true;
  toast('Captured timestamps changed. Reopen the timestamp review before exporting or uploading.');
  return false;
}

function attachCandidateReview(rows, mappedItems, action) {
  const decisions = assessTimestampCandidates(mappedItems);
  const bySource = new Map(rows.filter(row => row.item[overviewSource] !== undefined).map(row => [row.item[overviewSource], row]));
  const byCanonical = new Map(rows.map(row => [row.canonical, row]));
  for (const item of mappedItems) {
    const decision = decisions.get(item);
    const row = byCanonical.get(item) || bySource.get(item[overviewSource]);
    if (!row) continue;
    if (!decision.allowed) { row.status = 'Unavailable'; row.reason = decision.reason; }
    if (decision.conflict && row.item[overviewSource] !== undefined) {
      row.onChoose = () => {
        const original = state.allItems[row.item[overviewSource]];
        if (!original || capturedSegmentKey(original) !== capturedSegmentKey(row.item)) {
          toast('Capture changed. Reopen the review.'); return;
        }
        // Retain every alternative, but only one explicit choice for this candidate set.
        for (const candidate of state.allItems) if (candidate._timingReview === decision.signature) delete candidate._timingReview;
        original._timingReview = decision.signature;
        scheduleCaptureSave();
        state.submitInProgress = false;
        updateSubmitBtn('Submit to IntroDB');
        if (action === 'submit') submitToIntroDB(); else exportJSON();
      };
    }
  }
  return mappedItems.filter(item => decisions.get(item).allowed);
}

async function mapCapturedItemsWithTvdb(action, capturedItems = state.allItems.map((item, index) => ({ ...item, [overviewSource]: index }))) {
  const pendingItems = capturedItems.filter(item => !item.imdb_id || item.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length) {
    toast(`${pendingItems.length} timestamp(s) without an IMDb ID will be skipped from ${action}.`);
  }

  const validItems = capturedItems.filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING');
  const movieItems = validItems.filter(isMovieItem);
  const seriesGroups = new Map();
  for (const item of validItems.filter(item => !isMovieItem(item))) {
    const key = JSON.stringify([item.imdb_id, item._timing?.source === 'manual']);
    if (!seriesGroups.has(key)) seriesGroups.set(key, []);
    seriesGroups.get(key).push(item);
  }

  // Movies have no season/episode pair and deliberately bypass TVDB mapping.
  const items = movieItems.slice();
  let unreliableSkipped = 0;
  let specialSegmentsExcluded = 0;
  const reasonLabels = {
    genericTitle: 'generic title',
    missingTitle: 'missing title',
    duplicateProviderTitle: 'duplicate provider title',
    noExactMatch: 'no exact normalized TVDB match',
    ambiguousTvdbTitle: 'ambiguous TVDB title',
    reusedTvdbEpisode: 'TVDB episode already matched',
    missingAbsoluteNumber: 'title without an absolute episode number',
    absoluteEpisodeNotFound: 'absolute TVDB episode not found',
    ambiguousAbsoluteEpisode: 'ambiguous absolute TVDB episode',
    invalidCanonicalEpisode: 'TVDB episode without canonical default numbering',
  };
  const describeReasons = reasons => Object.entries(reasons || {})
    .map(([reason, count]) => `${reasonLabels[reason] || reason}: ${count}`)
    .join(', ') || 'none';
  for (const seriesItems of seriesGroups.values()) {
    const imdbId = seriesItems[0].imdb_id;
    const showId = getItemShowId(seriesItems[0]);
    const catalog = seriesItems[0]._timing?.source === 'manual'
      ? seriesItems.map(item => ({ season: item.season, episode: item.episode, title: item._episodeTitle }))
      : showId
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
    } else if (mapped.method === 'absolute-title') {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: GTST episodes mapped by absolute episode number and verified by exact normalized TVDB title. Regular episodes matched: ${stats.regularEpisodesMatched}; skipped: ${stats.regularEpisodesSkipped}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}; captured regular segments omitted: ${stats.capturedRegularSegmentsSkipped}.`);
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

function filterShortOutputSegments(items) {
  return items.filter(outputSegmentAllowed);
}

function annotateExistingComparison(row, item, existing) {
  if (!row || !existing || existing.error) return;
  row.existingSegments = existingSegmentsForDisplay(existing);
  row.existingRanges = existing.rangesByType?.get(item.segment_type) || [];
}

function normalizeMovieExportItem(item) {
  return {
    imdb_id: item.imdb_id,
    is_movie: true,
    segment_type: item.segment_type,
    start_sec: item.start_sec,
    end_sec: item.end_sec,
  };
}

function normalizeExportItem(item) {
  return isMovieItem(item) ? normalizeMovieExportItem(item) : {
    imdb_id: item.imdb_id, season: item.season, episode: item.episode,
    segment_type: item.segment_type, start_sec: item.start_sec, end_sec: item.end_sec,
  };
}

async function loadCanonicalExisting(episodeKeys) {
  const results = new Map();
  // Avoid bursts of hundreds of requests for large captured catalogues.
  for (let index = 0; index < episodeKeys.length; index += 4) {
    const batch = await Promise.all(episodeKeys.slice(index, index + 4).map(async key => [
      key, await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
    ]));
    for (const [key, value] of batch) results.set(key, value);
  }
  return results;
}

async function exportJSON() {
  if (state.exportInProgress || state.submitInProgress) {
    toast('An operation is already in progress. Please wait.');
    return;
  }
  state.exportInProgress = true;
  try { await prepareJSONExport(); }
  catch (error) {
    toast(error.message || 'Export failed. Please try again.');
    setIntrodbStatus('Export stopped. Please try again when the connection is available.');
  } finally { state.exportInProgress = false; }
}

async function prepareJSONExport() {
  if (!state.allItems.length) {
    toast('No timestamps yet.');
    return;
  }
  const capturedItems = state.allItems.map((item, index) => ({ ...item, [overviewSource]: index }));
  const snapshot = captureSnapshot();
  const view = {
    items: [], fileCount: 0, duplicateCount: 0, checking: true,
    rows: capturedItems.map(item => ({ item, status: 'Checking', reason: '' })),
    message: 'Checking TVDB mapping and IntroDB…',
  };
  const refresh = showExportPreview(view);
  try {
    if (hasTvItems(capturedItems) && !state.tvdbApiKey) {
      revealApiSettings();
      toast('Please enter your own TVDB API key before exporting JSON.');
      setTvdbStatus('No TVDB API key configured');
      view.message = 'TVDB API key missing. Timestamps remain available; JSON download is disabled.';
      return;
    }
    if (state.submitInProgress) {
      toast('Submission in progress, please wait...');
      return;
    }

    toast('Validating JSON export against TVDB...');
    const mapped = await mapCapturedItemsWithTvdb('JSON export', capturedItems);
    const mappedItems = mapped.items;
    for (const row of view.rows) {
      row.status = 'Unavailable';
      row.reason = !row.item.imdb_id || row.item.imdb_id === 'IMDB_PENDING'
        ? 'Missing IMDb ID' : 'No reliable TVDB mapping / excluded special';
    }
    for (const item of mappedItems) {
      const row = view.rows[item[overviewSource]];
      if (row) {
        row.canonical = item;
        row.status = 'Checking';
        row.reason = '';
        if (!filterShortOutputSegments([item]).length) {
          row.status = 'Unavailable';
          row.reason = 'Invalid duration or unsupported segment type';
        }
      }
    }
    let items = attachCandidateReview(view.rows, filterShortOutputSegments(mappedItems), 'export');
    const shortSegmentCount = mappedItems.length - filterShortOutputSegments(mappedItems).length;
    if (shortSegmentCount > 0) {
      toast(`${shortSegmentCount} invalid or unsupported segment(s) removed from export.`);
    }
    if (!items.length) {
      if (view.rows.some(row => row.onChoose)) {
        view.message = 'Review conflicting timestamps against the video, then choose one range per segment.';
        return;
      }
      if (mappedItems.length && shortSegmentCount === mappedItems.length) {
        toast(`All mapped segments have invalid durations or unsupported movie types; nothing was exported.`);
        return;
      }
      const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
      const noMappingMessage = 'No series has a reliable TVDB episode mapping; nothing was exported.';
      toast(onlySpecials ? 'Only provider specials were captured; nothing was exported.' : noMappingMessage);
      return;
    }

    const episodeKeys = [...new Set(
      items
        .map(item => getItemCacheKey(item))
    )];
    toast(`Checking IntroDB for existing segments (${episodeKeys.length} media item(s))...`);
    const canonicalExisting = new Map();
    for (let index = 0; index < episodeKeys.length; index += 4) {
      await Promise.all(episodeKeys.slice(index, index + 4).map(async key => {
        try {
          canonicalExisting.set(key, await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }));
        } catch (error) {
          canonicalExisting.set(key, { error: error?.message || 'IntroDB duplicate check failed.' });
        }
      }));
    }

    const eligibleMovies = await filterMoviesWithKnownExtraScenes(items.filter(item => !canonicalExisting.get(getItemCacheKey(item))?.error), canonicalExisting);
    const eligibleSet = new Set(eligibleMovies);
    for (const item of items) {
      if (isMovieItem(item) && !canonicalExisting.get(getItemCacheKey(item))?.error && !eligibleSet.has(item)) {
        const row = view.rows[item[overviewSource]];
        if (row) { row.status = 'Unavailable'; row.reason = 'Movie excluded by extra-scene checks'; }
      }
    }
    items = items.filter(item => !isMovieItem(item) || canonicalExisting.get(getItemCacheKey(item))?.error || eligibleSet.has(item));
    const uploadCandidates = items.filter(item => !canonicalExisting.get(getItemCacheKey(item))?.error && !hasExistingSegment(canonicalExisting.get(getItemCacheKey(item)), item));
    items = items.filter(item => {
      const key = getItemCacheKey(item);
      const existing = canonicalExisting.get(key);
      const row = view.rows[item[overviewSource]];
      const failed = Boolean(existing.error);
      const duplicate = !failed && hasExistingSegment(existing, item);
      if (row) {
        row.status = failed ? 'Unavailable' : duplicate ? 'In IntroDB' : 'NEW';
        row.reason = failed ? existing.error : '';
        annotateExistingComparison(row, item, existing);
      }
      if (failed) toast(existing.error);
      return !failed && !duplicate;
    });
    const duplicateCount = view.rows.filter(row => row.status === 'In IntroDB').length;
    view.duplicateCount = duplicateCount;
    if (duplicateCount > 0) toast(`${duplicateCount} duplicate(s) already in IntroDB removed from export.`);
    if (!items.length) {
      toast('Nothing left to export after removing duplicates.');
    }

    const exportItems = items.map(normalizeExportItem);
    const uploadItems = uploadCandidates.map(normalizeExportItem);
    const groups = new Map();
    for (const item of exportItems) {
      const key = item.imdb_id || 'no_id';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    let files = [];
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

    let downloaded = 0, downloadCount = exportItems.length;
    function downloadNext(index) {
      if (index >= files.length) {
        const summary = `${downloaded} file(s) downloaded · ${downloadCount} entries`;
        document.getElementById('nfe-export-preview')?.remove();
        if (downloadCount < exportItems.length || view.rows.some(row => row.status === 'Unavailable') || !captureStillCurrent(snapshot)) {
          toast(`${summary}; captures retained because some timestamps still need review.`);
        } else resetCapturedData(`${summary}; captured data cleared.`);
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

    Object.assign(view, {
      items: exportItems,
      fileCount: files.length,
      duplicateCount,
      uploadItems,
      onConfirm: exportItems.length ? (_, visible = exportItems) => {
        if (!captureStillCurrent(snapshot)) return;
        const chosen = new Set(exportItems.filter(item => visible.includes(item)));
        if (!chosen.size) return;
        const byTitle = new Map();
        for (const item of chosen) { if (!byTitle.has(item.imdb_id)) byTitle.set(item.imdb_id, []); byTitle.get(item.imdb_id).push(item); }
        files = [];
        for (const [imdbId, entries] of byTitle) {
          const total = Math.ceil(entries.length / maxItemsPerFile);
          for (let index = 0; index < total; index++) files.push({ imdbId, part: total > 1 ? `_part${index+1}of${total}` : '', data: entries.slice(index*maxItemsPerFile,(index+1)*maxItemsPerFile) });
        }
        downloadCount = chosen.size;
        downloadNext(0);
      } : undefined,
      requiresApproval: uploadItems.length > 0,
      onUpload: uploadItems.length ? (selected = []) => {
        if (!captureStillCurrent(snapshot)) return;
        if (!state.introdbApiKey) {
          revealApiSettings();
          toast('Please enter your IntroDB API key in API settings before uploading.');
          setIntrodbStatus('No API key configured');
          return;
        }
        const approved = uploadItems.filter(item => selected.includes(item));
        startIntrodbUpload(approved, { skipped: capturedItems.length - approved.length, snapshot });
      } : undefined,
    });
  } catch (error) {
    view.message = error.message || 'Validation failed. JSON download is disabled.';
    toast(view.message);
  } finally {
    view.checking = false;
    for (const row of view.rows) {
      if (row.status === 'Checking') {
        row.status = 'Unavailable';
        row.reason = view.message || 'Validation could not be completed';
      }
    }
    view.message = view.items.length
      ? 'Only verified NEW timestamps are included in the JSON download. Use Upload to IntroDB to submit the reviewed scraper ranges directly.'
      : 'No eligible new timestamps. Exact duplicates cannot be uploaded again. ' + (view.message.includes('Checking') ? '' : view.message);
    refresh?.(view);
  }
}

function updateSubmitBtn(label) {
  const button = document.getElementById('nfe-submit');
  if (button) button.textContent = label;
}

function startIntrodbUpload(items, { skipped = 0, snapshot = captureSnapshot() } = {}) {
  if (!items?.length) return;
  state.submitInProgress = true;
  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn(`Submitting 0/${items.length}...`);
  let sent = 0;

  function sendNext(index) {
    if (!captureStillCurrent(snapshot)) {
      state.submitInProgress = false;
      updateSubmitBtn('Submit to IntroDB');
      return;
    }
    if (index >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('Submit to IntroDB');
      const summary = `IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
      if (fail === 0 && ok > 0 && skipped === 0) {
        resetCapturedData(`${summary}; captured data cleared.`);
      } else {
        toast(summary);
        setIntrodbStatus(summary);
      }
      return;
    }

    const item = items[index];
    Promise.resolve().then(async () => {
      const key = uploadSegmentKey(item);
      const existing = await loadExistingSegmentsForEpisode(getItemCacheKey(item), undefined, { useCache: false, writeCache: false });
      if (!captureStillCurrent(snapshot)) throw new Error('Capture changed during the duplicate check. Review again.');
      if (acceptedUploadKeys.has(key) || hasExistingSegment(existing, item)) return { duplicate: true };
      const result = await submitSegment(item, state.introdbApiKey);
      if (result.success) acceptedUploadKeys.add(key);
      return result;
    }).then(result => {
      sent++;
      if (result.duplicate) {
        skipped++;
      } else if (result.success) {
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

async function submitToIntroDB() {
  if (state.exportInProgress || state.submitInProgress) {
    toast('An operation is already in progress. Please wait.');
    return;
  }
  try { await prepareIntroDBSubmission(); }
  catch (error) {
    state.submitInProgress = false;
    updateSubmitBtn('Submit to IntroDB');
    toast(error.message || 'Submission failed. Please try again.');
    setIntrodbStatus('Submission stopped. Please try again when the connection is available.');
  }
}

async function prepareIntroDBSubmission() {
  if (!state.allItems.length) {
    toast('No timestamps to submit.');
    return;
  }
  if (!state.introdbApiKey) {
    revealApiSettings();
    toast('Please enter your IntroDB API key in API settings.');
    setIntrodbStatus('No API key configured');
    return;
  }
  const requiresTvdb = hasTvItems(state.allItems);
  if (requiresTvdb && !state.tvdbApiKey) {
    revealApiSettings();
    toast('Please enter your own TVDB API key in the panel above.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  state.submitInProgress = true;
  const snapshot = captureSnapshot();
  updateSubmitBtn(requiresTvdb ? 'Checking TVDB...' : 'Preparing submission...');
  const stopSubmission = () => {
    state.submitInProgress = false;
    updateSubmitBtn('Submit to IntroDB');
  };

  const mapped = await mapCapturedItemsWithTvdb('IntroDB submission');
  const capturedItems = mapped.capturedItems;
  const mappedItems = mapped.items;
  const validMapped = filterShortOutputSegments(mappedItems);
  const rows = validMapped.map(item => ({ item: capturedItems[item[overviewSource]] || item, canonical: item, status: 'NEW', reason: '' }));
  const allMapped = attachCandidateReview(rows, validMapped, 'submit');
  const shortSegmentCount = mappedItems.length - validMapped.length;
  if (shortSegmentCount > 0) {
    toast(`${shortSegmentCount} invalid or unsupported segment(s) skipped.`);
  }
  if (!allMapped.length) {
    if (rows.some(row => row.onChoose)) {
      showExportPreview({ mode: 'submit', items: [], rows, checking: false, duplicateCount: 0,
        message: 'Review conflicting ranges against the video, then choose one range per segment.', onCancel: stopSubmission });
      stopSubmission();
      return;
    }
    if (mappedItems.length && shortSegmentCount === mappedItems.length) {
      toast(`All mapped segments have invalid durations or unsupported movie types; nothing was submitted.`);
      setIntrodbStatus(`Nothing submitted: segments must be at least 5 seconds`);
      stopSubmission();
      return;
    }
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    const noMappingMessage = hasTvItems(mapped.capturedItems)
      ? 'No series has a reliable TVDB episode mapping; nothing was submitted.'
      : 'No movie has a usable IMDb ID; nothing was submitted.';
    toast(onlySpecials ? 'Only provider specials were captured; nothing was submitted.' : noMappingMessage);
    setIntrodbStatus(onlySpecials ? 'Nothing submitted: specials are excluded' : noMappingMessage);
    stopSubmission();
    return;
  }

  const mediaKeys = [...new Set(
    allMapped
      .filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')
      .map(getItemCacheKey)
  )];
  toast(`Checking IntroDB for existing segments (${mediaKeys.length} media item(s))...`);
  const canonicalExisting = await loadCanonicalExisting(mediaKeys);

  const safeMapped = await filterMoviesWithKnownExtraScenes(allMapped, canonicalExisting);
  const safeSet = new Set(safeMapped);
  for (const row of rows) {
    const item = row.canonical;
    const existing = canonicalExisting.get(getItemCacheKey(item));
    annotateExistingComparison(row, item, existing);
    if (row.status === 'Unavailable') continue;
    if (!safeSet.has(item)) {
      row.status = 'Unavailable';
      row.reason = 'Movie excluded by extra-scene checks';
    } else if (hasExistingSegment(existing, item)) {
      row.status = 'In IntroDB';
      row.reason = 'Exact range already exists in IntroDB';
    }
  }
  const items = safeMapped.filter(item => {
    const key = getItemCacheKey(item);
    return !hasExistingSegment(canonicalExisting.get(key), item);
  });
  if (!items.length) {
    const allDuplicates = safeMapped.length > 0;
    const uploadItems = [];
    toast(allDuplicates ? 'All timestamps already exist in IntroDB.' : 'No timestamps remain eligible for upload after the extra-scene checks.');
    setIntrodbStatus(allDuplicates ? 'Nothing new to submit (all duplicates)' : 'Nothing submitted: extra scene detected or TMDB check unavailable');
    showExportPreview({
      mode: 'submit',
      items: [],
      uploadItems,
      fileCount: 0,
      duplicateCount: rows.filter(row => row.status === 'In IntroDB').length,
      checking: false,
      rows,
      requiresApproval: false,
      message: allDuplicates
        ? 'These exact ranges already exist in IntroDB and cannot be uploaded again.'
        : 'No timestamp can be uploaded from this item. The current IntroDB timestamps remain visible for comparison.',
    });
    stopSubmission();
    return;
  }

  showExportPreview({
    mode: 'submit',
    items,
    fileCount: items.length,
    duplicateCount: rows.filter(row => row.status === 'In IntroDB').length,
    checking: false,
    rows,
    message: 'Compare the Scraper and IntroDB lines, then explicitly approve this upload. Differences can be caused by provider offsets.',
    requiresApproval: true,
    approvalLabel: 'I manually compared every Scraper timestamp with the current IntroDB timestamp(s) for this exact video and approve this upload.',
    onCancel: stopSubmission,
    onConfirm: (selected = []) => {
      if (!captureStillCurrent(snapshot)) { stopSubmission(); return; }
      const approved = items.filter(item => selected.includes(item));
      startIntrodbUpload(approved, { skipped: capturedItems.length - approved.length, snapshot });
    },
  });
}

function resetCapturedData(message = 'Data cleared') {
  manualCapture?.reset();
  const introdbApiKey = state.introdbApiKey;
  const panelVisible = state.panelVisible;
  const { apiKey: tvdbApiKey, pin: tvdbPin } = loadTvdbSettings();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, createState(activeProviderConfig.name), { introdbApiKey, tvdbApiKey, tvdbPin, panelVisible });
  clearCaptureSession();
  updateCounters();
  updatePanelTitle();
  setDbStatus(`Waiting for ${activeProviderConfig.name} metadata...`);
  setIntrodbStatus('');
  updateImdbInput();
  toast(message);
}

function clearData() {
  if (state.submitInProgress || state.exportInProgress) { toast('Please wait until the current operation finishes.'); return; }
  if (!confirm('Delete all captured timestamps?')) return;
  resetCapturedData();
}

function revealApiSettings() {
  const settings = document.getElementById('nfe-settings');
  if (settings) settings.open = true;
}

function configurePanelCallbacks() {
  const manualAction = action => () => {
    try { Promise.resolve(action()).catch(error => toast(error.message)); }
    catch (error) { toast(error.message); }
  };
  manualCapture = createManualCapture({
    getContext: () => {
      if (state.updateRequired || state.exportInProgress || state.submitInProgress) throw new Error('Wait for the current operation to finish before marking timestamps.');
      const value = id => document.getElementById(`nfe-manual-${id}`)?.value || '';
      const context = { provider: activeProviderName, showId: state.showId, imdbId: state.imdbId,
        mediaType: value('media'), season: Number(value('season')), episode: Number(value('episode')),
        episodeTitle: value('title').trim(), segmentType: value('type'), page: location.href };
      if (state.showId && state.mediaType !== context.mediaType) throw new Error('The selected media type differs from the detected title. Open the correct playing title first.');
      if (context.mediaType === 'movie' && !movieCaptureAllowedForProvider(activeProviderName)) throw new Error('Movie capture is temporarily disabled for this provider. TV episode capture remains available.');
      validateManualIdentity(context);
      return context;
    },
    record: item => recordExtractedSegments([item], activeProviderName),
    render: updateManualCapture,
  });
  window.nfePanelCallbacks = {
    onManualStart: manualAction(() => manualCapture.mark('start')),
    onManualEnd: manualAction(() => manualCapture.mark('end')),
    onManualPreviewStart: manualAction(() => manualCapture.preview('start')),
    onManualPreviewEnd: manualAction(() => manualCapture.preview('end')),
    onManualSave: manualAction(() => manualCapture.save(document.getElementById('nfe-manual-reviewed')?.checked)),
    onManualReset: () => manualCapture.reset(),
    onDiagnostics: () => {
      const movies = state.skyShowtimeMovieDiagnostics || [];
      if (!movies.length) { toast('Open a SkyShowtime movie first to capture its markers.'); return; }
      const blob = new Blob([JSON.stringify({ provider: 'skyshowtime', movies }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: 'skyshowtime-movie-diagnostics.json' });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onClose: closePanel,
    onExport: exportJSON,
    onSubmit: submitToIntroDB,
    onClear: clearData,
    onImdbSet: () => {
      manualCapture.reset('IMDb identity changed. Mark both boundaries again.');
      const value = document.getElementById('nfe-imdb-input').value.trim();
      if (!value) return;
      state.imdbId = value;
      applyImdbIdToShow(value, state.showId, { overwrite: true });
      state.dedupCacheV2 = {};
      setDbStatus(`ID saved: ${value}`);
      updateCounters();
      loadCurrentIntrodbSegments(value).catch(error => setIntrodbStatus(error.message));
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
      searchImdbByTitle(query, state.showYear, { mediaType: state.mediaType || 'tv' }).then(result => {
        if (result.success) {
          applyImdbIdToShow(result.imdbId, searchShowId);
          if (searchShowId && state.showId !== searchShowId) return;
          state.imdbId = result.imdbId;
          updateImdbInput();
          setDbStatus(`Found: ${result.imdbId}`);
          updateCounters();
          loadCurrentIntrodbSegments(result.imdbId).catch(error => setIntrodbStatus(error.message));
        } else {
          setDbStatus(`IMDb lookup failed: ${result.error}`);
        }
      }).catch(error => {
        console.error('[NFE] Manual IMDb search error:', error);
        setDbStatus('IMDb lookup error');
      });
    },
    onTmdbSet: () => {
      const input = document.getElementById('nfe-tmdb-input');
      const saved = saveTmdbToken(input.value);
      input.value = '';
      toast(saved ? 'TMDB token updated locally; movie checks run on export and upload.' : 'Could not save TMDB token.');
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
    if (event.target.closest?.('#nfe-export-preview')) return;
    const panel = document.getElementById('nfe-panel');
    const button = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(event.target) && !button?.contains(event.target)) closePanel();
  }, true);
}

function syncVisibility() {
  const panel = document.getElementById("nfe-panel");
  if (panel && state.panelVisible) {
    panel.style.opacity = "1";
    panel.style.pointerEvents = "auto";
  }
}

function bootstrapProvider({
  providerName,
  setupInterception,
  isPlayerPage = () => Boolean(document.querySelector('video')),
}) {
  activeProviderName = String(providerName || 'netflix').trim().toLowerCase();
  activeProviderConfig = getProviderConfig(activeProviderName);
  Object.assign(state, createState(activeProviderConfig.name));
  restoreCaptureSession(activeProviderName);
  removeDisabledMovieCaptures(activeProviderName);
  window.addEventListener('pagehide', saveCaptureSession);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveCaptureSession(); });
  loadIntrodbSettings();
  loadTvdbSettings();
  setProviderName(providerName);
  configurePanelCallbacks();
  setupInterception();
  setupPanelHandler();
  checkForRequiredUpdate().then(result => {
    if (!result.required) return;
    saveCaptureSession();
    const showNotice = () => {
      if (document.body) showRequiredUpdate();
      else setTimeout(showNotice, 50);
    };
    showNotice();
  });

  let lastPath = location.pathname;
  let refreshTimer = null;
  const refreshControls = () => {
    refreshTimer = null;
    if (!document.body) return;
    if (state.updateRequired) {
      if (!document.getElementById('nfe-panel')) showRequiredUpdate();
      return;
    }
    const inPlayer = isPlayerPage();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      manualCapture?.reset('Page changed. Confirm the playing title/episode and mark both boundaries again.');
      scheduleCaptureSave();
      if (!inPlayer) {
        document.getElementById('nfe-panel')?.remove();
        state.panelVisible = false;
      }
    }
    if (inPlayer) injectBtn(providerName, getNextEpBtn);
    else removePlayerButton();
    const host = document.fullscreenElement || document.body;
    for (const id of ['nfe-panel', 'nfe-export-preview', 'nfe-toast']) {
      const element = document.getElementById(id);
      if (element && element.parentElement !== host) host.appendChild(element);
    }
    syncVisibility();
  };
  const scheduleRefresh = () => {
    if (refreshTimer === null) refreshTimer = setTimeout(refreshControls, 100);
  };
  const observePlayer = () => {
    refreshControls();
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(records => {
      if (records.every(record => record.target.closest?.('[id^="nfe-"]'))) return;
      scheduleRefresh();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) observePlayer();
  else document.addEventListener('DOMContentLoaded', observePlayer, { once: true });
  document.addEventListener('fullscreenchange', refreshControls);
  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('resize', scheduleRefresh);
  // Backstop for history changes that do not mutate the player DOM.
  setInterval(() => { if (!document.hidden) refreshControls(); }, 5000);

  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  win.__segmentScraper = {
    getAll: () => state.allItems,
    get state() {
      const { introdbApiKey, tvdbApiKey, tvdbPin, ...publicState } = state;
      return publicState;
    },
  };
}

  if (location.hostname === 'www.netflix.com' || location.hostname === 'netflix.com') {

/** Netflix-specific metadata interception and segment extraction. */


const NETFLIX_TITLE_OVERRIDES = {
  '81748089': 'tt2431250',
};

// Netflix movie creditsOffset consistently lands six seconds into the visible
// credits. Keep the correction movie-only; series markers use a different path.
const NETFLIX_MOVIE_CREDITS_LEAD_SEC = 6;

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

function coerceNetflixSeconds(value) {
  const number = timestampNumber(value);
  if (number !== null) return number;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function processNetflixMetadata(data) {
  const video = data.video;
  if (!video) return;

  const showId = video.id != null ? String(video.id) : null;
  if (String(video.type || '').toLowerCase() === 'movie') {
    handleDetectedShow({
      title: video.title,
      showId,
      year: video.year || video.releaseYear || '',
      mediaType: 'movie',
    });

    const creditsOffset = coerceNetflixSeconds(video.creditsOffset);
    const runtime = coerceNetflixSeconds(video.runtime);
    const correctedCreditsOffset = creditsOffset == null
      ? null
      : Math.max(0, creditsOffset - NETFLIX_MOVIE_CREDITS_LEAD_SEC);
    const movieId = showId || String(video.title || 'netflix-movie');
    const movieItem = correctedCreditsOffset != null && runtime != null && correctedCreditsOffset > 0 && runtime > creditsOffset
      ? createNormalizedSegment({
        providerName: 'netflix',
        episodeId: `${movieId}_movie_outro`,
        showId,
        season: null,
        episode: null,
        imdbId: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
        episodeTitle: video.title || '',
        mediaType: 'movie',
        providerSegmentType: 'creditsOffset',
        startSec: correctedCreditsOffset,
        endSec: runtime,
        durationSec: runtime,
        timing: { provider: 'netflix', source: 'credits-offset', unit: 'seconds', raw_start: creditsOffset, raw_end: runtime, correction_sec: -NETFLIX_MOVIE_CREDITS_LEAD_SEC },
      })
      : null;

    console.info('[NFE] Netflix movie credits marker processed', {
      title: video.title,
      movieId: showId,
      creditsOffset: creditsOffset ?? null,
      correctedCreditsOffset: correctedCreditsOffset ?? null,
      creditsStartCorrectionSec: NETFLIX_MOVIE_CREDITS_LEAD_SEC,
      runtime: runtime ?? null,
      captured: Boolean(movieItem),
      skipMarkers: video.skipMarkers ?? {},
    });

    if (movieItem) {
      logCapturedTimestamps({
        prefix: 'NFE',
        showTitle: video.title,
        mediaType: 'movie',
        episodeTitle: video.title || '',
        providerIdLabel: 'movieId',
        providerId: showId,
        items: [movieItem],
      });
      recordExtractedSegments([movieItem]);
      setDbStatus('Netflix movie outro captured; TMDB extra-scene checks run on export and upload.');
    } else {
      // A runtime is required as the actual media boundary. Never invent an
      // outro end at EOF when Netflix did not provide one.
      setDbStatus('Netflix movie: no complete creditsOffset/runtime range; no timestamps captured.');
    }
    return;
  }
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
  const capturedKeys = new Set(state.allItems.map(capturedSegmentKey));
  for (const season of video.seasons || []) {
    for (const episode of season.episodes || []) {
      const episodeId = episode.episodeId || episode.id;

      const common = {
        providerName: 'netflix',
        episodeId,
        showId,
        season: season.seq,
        episode: episode.seq,
        imdbId: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
        episodeTitle: episode.title || episode.name || '',
        durationSec: coerceNetflixSeconds(episode.runtime),
      };
      const markers = episode.skipMarkers || {};
      const segments = [
        markers.recap?.end > 0 && {
          providerSegmentType: 'recap',
          startSec: timestampNumber(markers.recap.start) === null ? null : Number(markers.recap.start) / 1000,
          endSec: timestampNumber(markers.recap.end) === null ? null : Number(markers.recap.end) / 1000,
        },
        markers.credit?.end > 0 && {
          providerSegmentType: 'credit',
          startSec: timestampNumber(markers.credit.start) === null ? null : Number(markers.credit.start) / 1000,
          endSec: timestampNumber(markers.credit.end) === null ? null : Number(markers.credit.end) / 1000,
        },
        markers.intro?.end > 0 && {
          providerSegmentType: 'intro',
          startSec: timestampNumber(markers.intro.start) === null ? null : Number(markers.intro.start) / 1000,
          endSec: timestampNumber(markers.intro.end) === null ? null : Number(markers.intro.end) / 1000,
        },
        episode.creditsOffset && episode.runtime && {
          providerSegmentType: 'creditsOffset',
          startSec: coerceNetflixSeconds(episode.creditsOffset),
          endSec: coerceNetflixSeconds(episode.runtime),
        },
      ].filter(Boolean);

      const episodeItems = [];
      for (const segment of segments) {
        const marker = markers[segment.providerSegmentType];
        const item = createNormalizedSegment({ ...common, ...segment, timing: {
          provider: 'netflix', source: marker ? 'skip-marker' : 'credits-offset', unit: marker ? 'milliseconds' : 'seconds',
          raw_start: marker ? marker.start : segment.startSec, raw_end: marker ? marker.end : segment.endSec,
        } });
        // Metadata can arrive in stages: an intro must not hide a later outro.
        if (item && !capturedKeys.has(capturedSegmentKey(item))) {
          capturedKeys.add(capturedSegmentKey(item));
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
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('memberapi') || !url.includes('metadata')) return originalFetch(input, init);

    return (async () => {
      const response = await originalFetch(input, init);
      try {
        const data = await response.clone().json();
        if (data?.video) processNetflixMetadata(data);
      } catch (_) {}
      return response;
    })();
  };
}

/** Netflix provider registration. */


bootstrapProvider({
  providerName: 'netflix',
  setupInterception: setupNetflixInterception,
  isPlayerPage: () => location.pathname.startsWith('/watch'),
});
  }

  if (location.hostname === 'primevideo.com' || location.hostname.endsWith('.primevideo.com') || (/^www\.amazon\./i.test(location.hostname) && location.pathname.startsWith('/gp/video/'))) {

/** Prime Video catalogue, playback-resource, and timestamp extraction. */


const PRIME_VIDEO_METADATA_URL_PATTERN = /getvodplaybackresources/i;
const PRIME_VIDEO_ID_PATTERN = /^(?:[A-Z0-9]{9,12}|amzn1\.dv\.gti\.[a-f0-9-]{20,})$/i;
const PRIME_VIDEO_CARD_SELECTOR = '[data-testid="episode-list-item"], li[id^="av-ep-episode-"]';
const PRIME_VIDEO_EPISODE_HEADING_PATTERN = /^\s*(\d+)\s*[.\-:]\s*(.*?)\s*$/;
const PRIME_VIDEO_POLL_INTERVAL_MS = 250;
const PRIME_VIDEO_MAX_POLL_ATTEMPTS = 40;
const PRIME_VIDEO_SELECTION_TTL_MS = 60000;
const PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS = 5000;
const PRIME_VIDEO_SEGMENT_BATCH_DELAY_MS = 500;
const PRIME_VIDEO_SUPPORTED_EVENT_TYPES = new Set([
  'SKIP_RECAP',
  'SKIP_INTRO',
  'END_CREDITS',
  'END_CREDIT',
  'NEXT_UP',
  'AFTER_CREDITS',
  'POST_CREDITS',
  'AFTER_CREDIT_SCENE',
  'POST_CREDIT_SCENE',
  'MID_CREDITS',
  'DURING_CREDITS',
  'MID_CREDIT',
  'DURING_CREDIT',
  'MID_CREDITS_SCENE',
  'DURING_CREDITS_SCENE',
  'MID_CREDIT_SCENE',
  'DURING_CREDIT_SCENE',
]);

const PRIME_VIDEO_EXTRA_SCENE_EVENT_TYPES = new Set([
  'AFTER_CREDITS',
  'POST_CREDITS',
  'AFTER_CREDIT_SCENE',
  'POST_CREDIT_SCENE',
  'MID_CREDITS',
  'DURING_CREDITS',
  'MID_CREDIT',
  'DURING_CREDIT',
  'MID_CREDITS_SCENE',
  'DURING_CREDITS_SCENE',
  'MID_CREDIT_SCENE',
  'DURING_CREDIT_SCENE',
]);

/** Keep Prime diagnostics in the regular Console log stream. */
function logPrimeVideo(message, details) {
  if (typeof console === 'undefined') return;
  const writeLog = typeof console.log === 'function'
    ? console.log.bind(console)
    : typeof console.info === 'function'
      ? console.info.bind(console)
      : null;
  if (!writeLog) return;
  if (details === undefined) writeLog(`[PVE] ${message}`);
  else writeLog(`[PVE] ${message}`, details);
}

function isPrimeVideoMetadataUrl(url) {
  return PRIME_VIDEO_METADATA_URL_PATTERN.test(String(url || ''));
}

function readPrimeVideoRequestBody(body) {
  if (typeof body === 'string') return body;
  if (!body) return '';
  try {
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData && typeof body.entries === 'function') {
      return [...body.entries()]
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
    }
  } catch (_) {}
  return '';
}

async function readPrimeVideoFetchRequestBody(input, init) {
  const initBody = readPrimeVideoRequestBody(init?.body);
  if (initBody) return initBody;
  try {
    if (input && typeof input === 'object' && typeof input.clone === 'function') {
      return await input.clone().text().catch(() => '');
    }
  } catch (_) {}
  return '';
}

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
  if (!(state.primeVideoMovieEventsByTitleId instanceof Map)) state.primeVideoMovieEventsByTitleId = new Map();
  if (!(state.primeVideoMovieRuntimeByTitleId instanceof Map)) state.primeVideoMovieRuntimeByTitleId = new Map();
  if (!(state.primeVideoMovieDurationPolls instanceof Map)) state.primeVideoMovieDurationPolls = new Map();
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
  const queryIdMatch = String(bodyText).match(/(?:^|[?&])(?:titleId|cGTI|asin|ASIN)=([^&#]+)/i);
  if (queryIdMatch) {
    const titleId = decodeURIComponent(queryIdMatch[1]);
    if (isPrimeVideoTitleId(titleId)) return titleId;
  }
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

function isPrimeVideoMovieType(value) {
  return ['MOVIE', 'FILM', 'FEATURE'].includes(String(value || '').trim().toUpperCase());
}

function isPrimeVideoMovieNode(node) {
  const typeValues = [
    node?.contentType,
    node?.type,
    node?.titleType,
    node?.subType,
    node?.subtype,
    node?.mediaType,
    node?.media_type,
    node?.entityType,
    node?.contentCategory,
    node?.catalogType,
    node?.videoType,
  ];
  return typeValues.some(isPrimeVideoMovieType) ||
    ['isMovie', 'isFilm', 'isFeature'].some(key => node?.[key] === true || node?.[key] === 1 || node?.[key] === 'true');
}

function findPrimeVideoMovieMetadata(root) {
  const candidates = [];
  const visited = new WeakSet();
  const episodeKeys = ['episodeNumber', 'episode', 'episodeSequenceNumber', 'episodeSequence'];

  function hasEpisodeNumber(node) {
    return episodeKeys.some(key => coercePrimeVideoInteger(node?.[key]) != null);
  }

  function walk(node, depth = 0, path = '') {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      return;
    }

    if (isPrimeVideoMovieNode(node) && !hasEpisodeNumber(node)) {
      const title = String(node.movieTitle || node.movieName || node.displayTitle || node.title || node.name || node.label || '').trim();
      const seriesTitle = String(node.seriesTitle || node.showTitle || node.parentTitle || '').trim();
      const year = node.releaseYear || node.year || node.releaseDate?.slice?.(0, 4) || '';
      const catalogScore = /catalogMetadata|catalog/i.test(path) ? 4 : 0;
      candidates.push({
        title: title || seriesTitle,
        year,
        score: catalogScore + (title ? 3 : 0) + (year ? 1 : 0),
      });
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

function normalizePrimeVideoEventType(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return {
    INTRO: 'SKIP_INTRO',
    RECAP: 'SKIP_RECAP',
    CREDITS: 'END_CREDITS',
    CREDIT: 'END_CREDIT',
  }[normalized] || normalized;
}

function getPrimeVideoEventType(event) {
  return normalizePrimeVideoEventType(
    event?.eventType || event?.elementType || event?.type || event?.name
  );
}

function getPrimeVideoTransitionRoots(data) {
  return [
    data?.transitionTimecodes?.result,
    data?.transitionTimecodes,
    data?.vodPlaybackUrls?.result?.transitionTimecodes?.result,
    data?.vodPlaybackUrls?.result?.transitionTimecodes,
    data?.vodPlaylistedPlaybackUrls?.result?.transitionTimecodes?.result,
    data?.vodPlaylistedPlaybackUrls?.result?.transitionTimecodes,
  ].filter(root => root && typeof root === 'object');
}

function readPrimeVideoTransitionBoundary(roots, keys) {
  for (const root of roots) {
    for (const key of keys) {
      const value = coercePrimeVideoMilliseconds(root?.[key]);
      if (value != null) return value;
    }
  }
  return null;
}

/**
 * Prime has returned two transition-timecode shapes over time: the current
 * result.events form and the older skipElements/endCreditsStart form. Keep
 * the rest of the extractor independent from that response detail.
 */
function readPrimeVideoTransitionEvents(data) {
  const roots = getPrimeVideoTransitionRoots(data);
  const rawEvents = [];
  const seenRawEvents = new Set();
  for (const root of roots) {
    for (const key of ['events', 'skipElements']) {
      if (!Array.isArray(root?.[key])) continue;
      for (const event of root[key]) {
        const rawKey = JSON.stringify(event);
        if (seenRawEvents.has(rawKey)) continue;
        seenRawEvents.add(rawKey);
        rawEvents.push(event);
      }
    }
  }

  const endCreditsStartMs = readPrimeVideoTransitionBoundary(roots, [
    'endCreditsStartMs',
    'endCreditsStart',
    'creditsStartMs',
    'creditsStart',
  ]);
  const endCreditsEndMs = readPrimeVideoTransitionBoundary(roots, [
    'endCreditsEndMs',
    'endCreditsEnd',
    'creditsEndMs',
    'creditsEnd',
  ]);
  const events = rawEvents.map(event => ({
    ...(event && typeof event === 'object' ? event : {}),
    eventType: getPrimeVideoEventType(event),
  }));

  const hasEndCreditsEvent = events.some(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)));
  if (!hasEndCreditsEvent && endCreditsStartMs != null) {
    events.push({
      eventType: 'END_CREDITS',
      startTimeMs: endCreditsStartMs,
      ...(endCreditsEndMs == null ? {} : { endTimeMs: endCreditsEndMs }),
    });
  } else if (endCreditsEndMs != null) {
    for (const event of events) {
      if (!['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event))) continue;
      if (readPrimeVideoEventTimeMs(event, 'end') == null) event.endTimeMs = endCreditsEndMs;
    }
  }
  return events;
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
  return readPrimeVideoTransitionEvents(data).some(event =>
    PRIME_VIDEO_SUPPORTED_EVENT_TYPES.has(getPrimeVideoEventType(event))
  );
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
    const previous = state.primeVideoTitleMap.get(titleId);
    const unchanged = previous?.showId === showId &&
      previous.season === season &&
      previous.episode === cardEpisode.episode &&
      previous.episodeTitle === cardEpisode.episodeTitle;
    if (!unchanged) {
      const collision = findPrimeVideoEpisodeCollision(titleId, showId, season, cardEpisode.episode);
      state.primeVideoTitleMap.set(titleId, snapshot);
      seasonCatalog.set(cardEpisode.episode, snapshot);
      refreshPrimeVideoEpisodeTitle(showId, season, cardEpisode.episode, cardEpisode.episodeTitle);
      if (!collision) {
        recordProviderEpisode({ providerId: titleId, season, episode: cardEpisode.episode, title: cardEpisode.episodeTitle }, showId);
      }
    } else if (!seasonCatalog.has(cardEpisode.episode)) {
      seasonCatalog.set(cardEpisode.episode, previous);
    }
    const detailId = readPrimeVideoCardDetailId(card);
    if (detailId) {
      const previousDetail = state.primeVideoDetailMap.get(detailId);
      const detailSnapshot = { ...(unchanged ? previous : snapshot), seriesTitle };
      if (!previousDetail ||
          previousDetail.showId !== detailSnapshot.showId ||
          previousDetail.season !== detailSnapshot.season ||
          previousDetail.episode !== detailSnapshot.episode ||
          previousDetail.episodeTitle !== detailSnapshot.episodeTitle ||
          previousDetail.seriesTitle !== detailSnapshot.seriesTitle) {
        state.primeVideoDetailMap.set(detailId, detailSnapshot);
      }
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
      const response = await fetchImpl(urlKey, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
      const seasonDocument = parseHtml(await response.text());
      const found = scanPrimeVideoEpisodeCatalog(seasonDocument);
      total += found;
      if (found) {
        logPrimeVideo('Preloaded Prime Video season catalogue:', {
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

function coercePrimeVideoClockMilliseconds(value) {
  const numeric = coercePrimeVideoMilliseconds(value);
  if (numeric != null) return numeric;
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return null;
  const seconds = parts.length === 2
    ? parts[0] * 60 + parts[1]
    : parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : null;
  return seconds == null || seconds < 0 ? null : seconds * 1000;
}

function readPrimeVideoEventTimeMs(event, boundary) {
  const keys = boundary === 'start'
    ? ['startTimeMs', 'startTimecodeMs', 'startTimeCodeMs', 'startMs']
    : ['endTimeMs', 'endTimecodeMs', 'endTimeCodeMs', 'endMs'];
  const nestedSources = [
    event,
    event?.timecode,
    event?.timeCode,
    event?.timecodes,
    event?.range,
  ];
  for (const source of nestedSources) {
    for (const key of keys) {
      const value = coercePrimeVideoClockMilliseconds(source?.[key]);
      if (value != null) return value;
    }
  }
  const secondKeys = boundary === 'start'
    ? ['startTime', 'start', 'startSec', 'startSeconds', 'offset']
    : ['endTime', 'end', 'endSec', 'endSeconds'];
  for (const source of nestedSources) {
    for (const key of secondKeys) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value) && value >= 0) return value * 1000;
      const clockMilliseconds = coercePrimeVideoClockMilliseconds(source?.[key]);
      if (clockMilliseconds != null) return clockMilliseconds;
    }
  }
  return null;
}

function findPrimeVideoRuntimeMs(root, events = []) {
  const candidates = events
    .map(event => readPrimeVideoEventTimeMs(event, 'end'))
    .filter(value => value != null);
  const visited = new WeakSet();
  const millisecondKeys = new Set([
    'runtimems', 'runtimemillis', 'runtimemilliseconds',
    'durationms', 'durationmillis', 'durationmilliseconds',
    'contentdurationms', 'contentdurationmillis', 'contentdurationmilliseconds',
  ]);
  const secondKeys = new Set([
    'runtimeseconds', 'runtimeinseconds',
    'durationseconds', 'durationinseconds',
    'runtime', 'duration', 'contentduration',
  ]);

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        if (millisecondKeys.has(normalizedKey)) candidates.push(number);
        if (secondKeys.has(normalizedKey)) candidates.push(
          ['runtime', 'duration', 'contentduration'].includes(normalizedKey) && number > 100000
            ? number
            : number * 1000
        );
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

function logPrimeVideoTimestamps(titleId, showId, season, episode, episodeTitle, items, mediaType = 'tv') {
  logCapturedTimestamps({
    prefix: 'PVE',
    showTitle: showId,
    mediaType,
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
  const items = batch.items.filter(item => !state.allItems.some(existing => existing._eid === item._eid && existing.start_sec === item.start_sec && existing.end_sec === item.end_sec));
  logPrimeVideo('Flushing Prime Video segment batch:', {
    titleId,
    showId: batch.showId,
    season: batch.season,
    episode: batch.episode,
    received: batch.items.length,
    newItems: items.length,
    skippedExisting: batch.items.length - items.length,
  });
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
    if (!batch.items.some(existing => existing._eid === item._eid && existing.start_sec === item.start_sec && existing.end_sec === item.end_sec)) batch.items.push(item);
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

function appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, segmentType, startTimeMs, endTimeMs, mediaType = 'tv', creditPart = null) {
  const isMovie = String(mediaType).toLowerCase() === 'movie';
  const partSuffix = creditPart ? `_${creditPart}` : '';
  const episodeId = isMovie ? `${titleId}_movie_${segmentType}${partSuffix}` : `${titleId}_${segmentType}${partSuffix}`;
  const alreadyCaptured = item => item.start_sec === startTimeMs / 1000 && item.end_sec === endTimeMs / 1000 && (item._eid === episodeId || (
    item._showId === showId &&
    String(item.media_type || 'tv').toLowerCase() === String(mediaType).toLowerCase() &&
    item.season === season &&
    item.episode === episode &&
    item.segment_type === segmentType &&
    (item.credit_part || null) === (creditPart || null)
  ));
  if ((!isMovie && state.allItems.some(alreadyCaptured)) || extractedItems.some(alreadyCaptured)) return false;
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: episodeTitle,
    _showId: showId,
    ...(isMovie ? { media_type: 'movie' } : {}),
    ...(creditPart ? { credit_part: creditPart } : {}),
    imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
    segment_type: segmentType,
    season,
    episode,
    start_sec: startTimeMs / 1000,
    end_sec: endTimeMs / 1000,
    _timing: { provider: 'prime-video', source: 'playback-event', unit: 'milliseconds', raw_start: startTimeMs, raw_end: endTimeMs },
  });
  return true;
}

function readPrimeVideoMoviePageTitle(titleId) {
  const heading = readPrimeVideoSeriesTitle(document);
  if (heading) return heading;
  const pageTitle = String(document.title || '')
    .replace(/^Prime Video[:\-]\s*/i, '')
    .trim();
  return pageTitle || titleId;
}

function clearPrimeVideoMovieDurationPoll(titleId) {
  const poll = state.primeVideoMovieDurationPolls.get(titleId);
  if (poll?.timer != null && typeof clearTimeout === 'function') clearTimeout(poll.timer);
  state.primeVideoMovieDurationPolls.delete(titleId);
}

function schedulePrimeVideoMovieDurationPoll(titleId, movieTitle) {
  if (typeof window === 'undefined' || typeof setTimeout !== 'function') return false;
  const existing = state.primeVideoMovieDurationPolls.get(titleId);
  if (existing?.timer != null) return true;
  if ((existing?.attempt || 0) >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) return false;

  const poll = existing || { attempt: 0, timer: null, movieTitle };
  poll.movieTitle = movieTitle || poll.movieTitle || titleId;
  poll.timer = setTimeout(() => {
    const current = state.primeVideoMovieDurationPolls.get(titleId);
    if (!current) return;
    current.timer = null;
    current.attempt++;
    state.primeVideoMovieDurationPolls.set(titleId, current);
    const events = state.primeVideoMovieEventsByTitleId.get(titleId) || [];
    if (!events.length) return;
    finalizePrimeVideoMovieEvents(
      titleId,
      current.movieTitle || titleId,
      { transitionTimecodes: { result: { events } } },
      state.primeVideoMovieRuntimeByTitleId.get(titleId) ?? null
    );
  }, PRIME_VIDEO_POLL_INTERVAL_MS);
  state.primeVideoMovieDurationPolls.set(titleId, poll);
  return true;
}

function hasPrimeVideoEpisodePageContext(titleId) {
  if (state.primeVideoTitleMap.has(titleId)) return true;
  if (state.primeVideoSelectedEpisode?.resolvedTitleId === titleId) return true;
  if (readPrimeVideoSelectedSeason(document) != null) return true;
  const cards = document.querySelectorAll?.(PRIME_VIDEO_CARD_SELECTOR) || [];
  return cards.length > 0;
}

function isLikelyPrimeVideoMoviePlayback(titleId, data) {
  if (state.mediaType === 'movie' && String(state.showId || '') === String(titleId)) return true;
  if (findPrimeVideoEpisodeMetadata(data) || hasPrimeVideoEpisodePageContext(titleId)) return false;
  const events = readPrimeVideoTransitionEvents(data);
  const hasCreditsEvent = events.some(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)));
  const hasCompleteCredits = events.some(event => {
    if (!['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event))) return false;
    const startTimeMs = readPrimeVideoEventTimeMs(event, 'start');
    const endTimeMs = readPrimeVideoEventTimeMs(event, 'end');
    return startTimeMs != null && endTimeMs != null && endTimeMs > startTimeMs;
  });
  const hasTvOnlyMarker = events.some(event => ['SKIP_RECAP', 'SKIP_INTRO'].includes(String(event?.eventType || '').toUpperCase()));
  return (hasCompleteCredits || hasCreditsEvent) && !hasTvOnlyMarker;
}

function finalizePrimeVideoMovieResponses(titleId, movieTitle, currentData = null) {
  const pending = state.primeVideoPendingByTitleId.get(titleId) || [];
  state.primeVideoPendingByTitleId.delete(titleId);
  state.primeVideoPollingTitleIds.delete(titleId);

  const payloads = [...pending, currentData].filter(data => hasPrimeVideoSegmentEvents(data));
  if (!payloads.length) return;
  const previousEvents = state.primeVideoMovieEventsByTitleId.get(titleId) || [];
  const incomingEvents = payloads.flatMap(data => readPrimeVideoTransitionEvents(data));
  const events = [];
  const seenEvents = new Set();
  for (const event of [...previousEvents, ...incomingEvents]) {
    const key = JSON.stringify(event);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    events.push(event);
  }
  state.primeVideoMovieEventsByTitleId.set(titleId, events);
  const runtimeCandidates = payloads
    .map(data => findPrimeVideoRuntimeMs(data, []))
    .filter(value => value != null);
  if (runtimeCandidates.length) {
    state.primeVideoMovieRuntimeByTitleId.set(titleId, Math.max(...runtimeCandidates));
  }
  finalizePrimeVideoMovieEvents(titleId, movieTitle, {
    transitionTimecodes: { result: { events } },
  }, state.primeVideoMovieRuntimeByTitleId.get(titleId) ?? null);
}

function finalizePrimeVideoMovieEvents(titleId, movieTitle, data, runtimeMsOverride = null) {
  const events = readPrimeVideoTransitionEvents(data);
  const extractedItems = [];
  const runtimeMs = runtimeMsOverride ?? findPrimeVideoRuntimeMs(data, []) ?? readPrimeVideoMediaDurationMs();
  const creditRanges = events
    .filter(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)))
    .map(event => ({
      startTimeMs: readPrimeVideoEventTimeMs(event, 'start'),
      endTimeMs: readPrimeVideoEventTimeMs(event, 'end') ?? runtimeMs,
    }))
    .filter(range => range.startTimeMs != null && range.endTimeMs != null && range.endTimeMs > range.startTimeMs);
  const creditRange = creditRanges.length ? {
    startTimeMs: Math.min(...creditRanges.map(range => range.startTimeMs)),
    endTimeMs: Math.max(...creditRanges.map(range => range.endTimeMs)),
  } : null;

  if (!creditRange) {
    const creditEvents = events
      .filter(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)))
      .map(event => ({
        type: getPrimeVideoEventType(event),
        startTimeMs: readPrimeVideoEventTimeMs(event, 'start'),
        endTimeMs: readPrimeVideoEventTimeMs(event, 'end'),
      }));
    const creditStartAvailable = creditEvents.some(event => event.startTimeMs != null);
    if (creditStartAvailable && schedulePrimeVideoMovieDurationPoll(titleId, movieTitle)) {
      const poll = state.primeVideoMovieDurationPolls.get(titleId);
      if (poll?.attempt === 0) {
        console.info('[PVE] Movie credits found; waiting for Prime media duration before finalizing:', {
          titleId,
          creditEvents,
        });
      }
      return;
    }
    console.warn('[PVE] Movie credits did not include a safe END_CREDITS range; NEXT_UP was ignored:', titleId, {
      creditEvents,
      eventTypes: events.map(getPrimeVideoEventType),
      runtimeMs,
    });
    return;
  }
  clearPrimeVideoMovieDurationPoll(titleId);

  const extraSceneEvents = events.filter(event => PRIME_VIDEO_EXTRA_SCENE_EVENT_TYPES.has(getPrimeVideoEventType(event)));
  const extraSceneEvent = extraSceneEvents
    .map(event => ({
      event,
      startTimeMs: readPrimeVideoEventTimeMs(event, 'start'),
      endTimeMs: readPrimeVideoEventTimeMs(event, 'end'),
    }))
    .filter(range => range.startTimeMs != null)
    .sort((a, b) => a.startTimeMs - b.startTimeMs)[0];
  const ranges = splitCreditRange({
    startSec: creditRange.startTimeMs / 1000,
    endSec: creditRange.endTimeMs / 1000,
    runtimeSec: runtimeMs == null ? null : runtimeMs / 1000,
    afterCreditsDetected: extraSceneEvents.length > 0,
    afterCreditsStartSec: extraSceneEvent?.startTimeMs == null ? null : extraSceneEvent.startTimeMs / 1000,
    afterCreditsEndSec: extraSceneEvent?.endTimeMs == null ? null : extraSceneEvent.endTimeMs / 1000,
  });
  for (const range of ranges) {
    appendPrimeVideoSegment(
      extractedItems,
      titleId,
      titleId,
      null,
      null,
      movieTitle,
      range.segmentType || 'outro',
      range.startSec * 1000,
      range.endSec * 1000,
      'movie',
      range.creditPart
    );
  }
  if (!ranges.length) console.warn('[PVE] Movie credits conflict with scene markers; withholding timestamps.', { titleId, creditRange, extraSceneEvent });

  const existingMovieItems = state.allItems.filter(item =>
    String(item?._showId || '') === String(titleId) &&
    String(item?.media_type || '').toLowerCase() === 'movie' &&
    ['outro', 'post-credits'].includes(item.segment_type)
  );
  const sameAsExisting = existingMovieItems.length === extractedItems.length && extractedItems.every(item =>
    existingMovieItems.some(existing =>
      existing._eid === item._eid &&
      Math.abs(Number(existing.start_sec) - Number(item.start_sec)) < 0.01 &&
      Math.abs(Number(existing.end_sec) - Number(item.end_sec)) < 0.01
    )
  );
  if (sameAsExisting) return;
  if (existingMovieItems.length) {
    state.allItems = state.allItems.filter(item => !existingMovieItems.includes(item));
  }
  logPrimeVideoTimestamps(titleId, movieTitle, null, null, movieTitle, extractedItems, 'movie');
  recordExtractedSegments(extractedItems);
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
  const events = readPrimeVideoTransitionEvents(data);
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
  const outroCandidates = events.filter(event => {
    const eventType = getPrimeVideoEventType(event);
    return eventType === 'END_CREDITS' || eventType === 'END_CREDIT' || eventType === 'NEXT_UP';
  });
  const outroRange = outroCandidates
    .filter(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)))
    .map(event => resolveEventRange(event, true))
    .find(Boolean) || outroCandidates
    .filter(event => getPrimeVideoEventType(event) === 'NEXT_UP')
    .map(event => resolveEventRange(event, true))
    .find(Boolean);

  for (const event of events) {
    let segmentType = null;
    const eventType = getPrimeVideoEventType(event);
    if (eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (eventType === 'SKIP_INTRO') segmentType = 'intro';
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
  logPrimeVideo(extractedItems.length
    ? 'Prepared Prime Video segment ranges:'
    : 'No usable Prime Video segment ranges in playback metadata:', {
    titleId,
    showId,
    season,
    episode,
    eventTypes: events.map(getPrimeVideoEventType),
    segments: extractedItems.map(item => ({ type: item.segment_type, start: item.start_sec, end: item.end_sec })),
  });
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
  if ((state.mediaType === 'movie' && String(state.showId || '') === String(titleId)) ||
      state.primeVideoMovieEventsByTitleId.has(titleId)) {
    finalizePrimeVideoMovieResponses(titleId, state.showTitle || titleId);
    return;
  }
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
  const eventTypes = (data?.transitionTimecodes?.result?.events || []).map(getPrimeVideoEventType);
  if (!titleId) {
    logPrimeVideo('Skipped playback metadata without a recognizable title ID:', { url: String(url || ''), bodyLength: String(bodyText || '').length, eventTypes });
    return;
  }
  logPrimeVideo('Received Prime Video playback metadata:', { titleId, eventTypes });
  const movieMetadata = findPrimeVideoMovieMetadata(data);
  if (movieMetadata) {
    const movieTitle = movieMetadata.title || titleId;
    console.info('[PVE] Movie metadata classified; skipping season/episode resolution.', {
      titleId,
      title: movieTitle,
      year: movieMetadata.year || '',
    });
    handleDetectedShow({
      title: movieTitle,
      showId: titleId,
      year: movieMetadata.year || '',
      mediaType: 'movie',
    });
    finalizePrimeVideoMovieResponses(titleId, movieTitle, data);
    return;
  }
  if (state.mediaType === 'movie' && String(state.showId || '') === String(titleId)) {
    finalizePrimeVideoMovieResponses(titleId, state.showTitle || titleId, data);
    return;
  }
  if (isLikelyPrimeVideoMoviePlayback(titleId, data)) {
    const movieTitle = readPrimeVideoMoviePageTitle(titleId);
    console.info('[PVE] Movie playback classified from credit events; skipping season/episode resolution.', {
      titleId,
      title: movieTitle,
    });
    handleDetectedShow({ title: movieTitle, showId: titleId, mediaType: 'movie' });
    finalizePrimeVideoMovieResponses(titleId, movieTitle, data);
    return;
  }
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
  if (!hasPrimeVideoSegmentEvents(data)) {
    logPrimeVideo('Playback metadata contained no supported segment events:', { titleId, eventTypes: (data?.transitionTimecodes?.result?.events || []).map(getPrimeVideoEventType) });
    return;
  }
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
    logPrimeVideo('Inferred next episode from the scanned season boundary:', {
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
    if (document.hidden) return;
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
    const observer = new MutationObserver(records => {
      if (records.every(record => record.target.closest?.('[id^="nfe-"]'))) return;
      if (scanTimer != null) return;
      scanTimer = setTimeout(() => { scanTimer = null; scanCatalog(); }, PRIME_VIDEO_POLL_INTERVAL_MS);
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
      bodyText = readPrimeVideoRequestBody(body);
      if (isPrimeVideoMetadataUrl(url)) {
        logPrimeVideo('Intercepted Prime Video playback XHR:', { url });
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
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ? String(input.url) : String(input || ''));
    if (!isPrimeVideoMetadataUrl(url)) return originalFetch(input, init);

    return (async () => {
      logPrimeVideo('Intercepted Prime Video playback fetch:', { url });
      const bodyText = await readPrimeVideoFetchRequestBody(input, init);
      const response = await originalFetch(input, init);
      try { processPrimeVideoMetadata(await response.clone().json(), bodyText, url); }
      catch (error) { console.error('[PVE] Failed to process fetch response:', error); }
      return response;
    })();
  };
  logPrimeVideo('Prime Video interception initialized.', {
    page: String(win.location?.href || (typeof location !== 'undefined' ? location.href : '')),
    xhr: typeof OriginalXHR === 'function',
    fetch: typeof win.fetch === 'function',
  });
}

/** Prime Video provider registration. */


bootstrapProvider({
  providerName: 'prime-video',
  setupInterception: setupPrimeVideoInterception,
});
  }

  if (location.hostname === 'videoland.com' || location.hostname.endsWith('.videoland.com')) {

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
  const parent = json?.seo?.parent || json?.parent || null;
  const type = String(
    json?.mediaType || json?.type || json?.videoType || json?.contentType ||
    json?.seo?.mediaType || json?.seo?.type || json?.seo?.contentType ||
    video?.mediaType || video?.type || video?.videoType || video?.contentType ||
    entity?.mediaType || entity?.type || entity?.videoType || entity?.contentType || ''
  ).trim().toLowerCase();
  return {
    entityId: entity?.id != null ? String(entity.id) : null,
    entity,
    mediaType: json?.isMovie === true || video?.isMovie === true || entity?.isMovie === true || ['movie', 'film', 'feature'].includes(type)
      ? 'movie'
      : 'tv',
    season: coerceVideolandNumber(video?.season ?? entity?.season ?? json?.season),
    episode: coerceVideolandNumber(video?.episode ?? entity?.episode ?? json?.episode),
    duration: coerceVideolandNumber(video?.duration ?? entity?.duration ?? json?.duration),
    programId: parent?.id != null
      ? String(parent.id)
      : (json?.programId ?? entity?.programId ?? entity?.seriesId) != null
        ? String(json?.programId ?? entity?.programId ?? entity?.seriesId)
        : null,
    programTitle: parent?.name || json?.programTitle || json?.seriesTitle || null,
    episodeTitle: video?.name || video?.title || entity?.episodeTitle || entity?.episodeName || null,
    extraTitle: video?.extraTitle || entity?.extraTitle || null,
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

function isVideolandMovieCreditsType(type) {
  return [
    'ending_credits',
    'endingcredits',
    'end_credits',
    'endcredits',
    'closing_credits',
    'closingcredits',
    'credits',
  ].includes(String(type || '').trim().toLowerCase());
}

function updateVideolandTitle(title, programId, mediaType = 'tv') {
  const showId = String(programId || title);
  handleDetectedShow({ title, showId, mediaType });
  return showId;
}

function normalizeVideolandEpisodeTitle(value) {
  return String(value || '').trim().replace(/^\d+\s*\.\s*/, '').trim();
}

function isVideolandGtstSeries(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() === 'goede tijden slechte tijden';
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
  const hasMovieCreditsChapter = (activeItem.video.chapters || []).some(chapter => isVideolandMovieCreditsType(chapter.type));
  const isMovie = rootMeta.mediaType === 'movie' || (season == null && episode == null && hasMovieCreditsChapter);
  const title = (rootMeta.programTitle || rootMeta.episodeTitle || activeItem.title || activeItem.video.title || activeItem.video.name || '').trim();
  const mediaId = isMovie ? (rootMeta.programId || rootMeta.entityId || clipId) : rootMeta.programId;
  const episodeTitle = chooseVideolandEpisodeTitle(rootMeta, activeItem, title);
  if (isMovie) {
    console.info('[VLE] Movie metadata classified; skipping TVDB mapping.', {
      title,
      showId: mediaId,
      clipId,
    });
  }
  if (!isMovie && !episodeTitle) {
    console.warn('[VLE] No episode-specific title found; the series title will not be used for TVDB matching.', {
      clipId,
      seriesTitle: title,
    });
  }
  const showId = updateVideolandTitle(title, mediaId, isMovie ? 'movie' : 'tv');
  const useGtstAbsoluteTitleMatch = isVideolandGtstSeries(title);
  state.clipMap.set(clipId, { season, episode, title, showId, mediaType: isMovie ? 'movie' : 'tv' });

  if (isMovie) {
    const extractedItems = [];
    const chapters = activeItem.video.chapters || [];
    const afterCreditsChapters = chapters.filter(chapter => [
      'after_credits',
      'aftercredits',
      'after_credits_scene',
      'aftercreditsscene',
      'post_credits',
      'postcredits',
      'post_credits_scene',
      'postcreditsscene',
    ].includes(String(chapter.type || '').trim().toLowerCase()));
    const afterCreditsChapter = afterCreditsChapters.slice().sort((a, b) => Number(a.tcStart) - Number(b.tcStart))[0];
    const creditChapters = chapters.filter(chapter => isVideolandMovieCreditsType(chapter.type)
      && coerceVideolandNumber(chapter.tcStart) != null && coerceVideolandNumber(chapter.tcEnd) != null
      && Number(chapter.tcEnd) > Number(chapter.tcStart));
    const fullCredits = creditChapters.length ? [{
      type: creditChapters[0].type,
      tcStart: Math.min(...creditChapters.map(chapter => Number(chapter.tcStart))),
      tcEnd: Math.max(...creditChapters.map(chapter => Number(chapter.tcEnd))),
    }] : [];
    for (const chapter of fullCredits) {
      const chapterType = String(chapter.type || '').trim().toLowerCase();
      if (!isVideolandMovieCreditsType(chapterType)) continue;
      const startSec = coerceVideolandNumber(chapter.tcStart);
      const endSec = coerceVideolandNumber(chapter.tcEnd);
      if (startSec == null || endSec == null || endSec <= startSec) continue;

      const ranges = splitCreditRange({
        startSec,
        endSec,
        afterCreditsDetected: afterCreditsChapters.length > 0,
        afterCreditsStartSec: coerceVideolandNumber(afterCreditsChapter?.tcStart),
        afterCreditsEndSec: coerceVideolandNumber(afterCreditsChapter?.tcEnd),
      });
      for (const range of ranges) {
        const episodeId = `${clipId}_movie_${range.segmentType || 'outro'}${range.creditPart ? `_${range.creditPart}` : ''}`;
        if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;
        extractedItems.push({
          _eid: episodeId,
          _episodeTitle: title,
          _showId: showId,
          media_type: 'movie',
          ...(range.creditPart ? { credit_part: range.creditPart } : {}),
          imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
          segment_type: range.segmentType || 'outro',
          season: null,
          episode: null,
          start_sec: range.startSec,
          end_sec: range.endSec,
        });
      }
    }
    logCapturedTimestamps({
      prefix: 'VLE',
      showTitle: title,
      mediaType: 'movie',
      episodeTitle: title,
      providerIdLabel: 'clipId',
      providerId: clipId,
      items: extractedItems,
    });
    recordExtractedSegments(extractedItems);
    return;
  }

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
    if ([...state.allItems, ...extractedItems].some(item => item._eid === episodeId && item.start_sec === startSec && item.end_sec === endSec)) continue;
    extractedItems.push({
      _eid: episodeId,
      _episodeTitle: episodeTitle,
      _showId: showId,
      _tvdbEpisodeLanguages: ['eng', 'nld'],
      ...(useGtstAbsoluteTitleMatch ? { _tvdbAbsoluteTitleMatch: true } : {}),
      imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: startSec,
      end_sec: endSec,
      _timing: { provider: 'videoland', source: 'chapter', unit: 'seconds', raw_start: startSec, raw_end: endSec },
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

/** Videoland provider registration. */


bootstrapProvider({
  providerName: 'videoland',
  setupInterception: setupVideolandInterception,
});
  }

  if (location.hostname === 'skyshowtime.com' || location.hostname.endsWith('.skyshowtime.com')) {

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
const SKYSHOWTIME_VARIANT_PATH = '/provider_variant_id/';

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
    (value.includes(SKYSHOWTIME_SERIES_PATH) || value.includes(SKYSHOWTIME_VARIANT_PATH));
}

function looksLikeSkyShowtimeEpisode(node) {
  if (!node || typeof node !== 'object' || node.episodeNumber == null) return false;
  const hasRuntime = node.durationMilliseconds != null || node.durationSeconds != null;
  const hasContext = Boolean(node.seriesName || node.providerSeriesId || node.providerVariantId || node.episodeName);
  const hasFormats = Boolean(node.formats && typeof node.formats === 'object');
  return hasRuntime || hasContext || hasFormats;
}

function isSkyShowtimeMovieType(value) {
  return ['movie', 'film', 'feature'].includes(String(value || '').trim().toLowerCase());
}

function looksLikeSkyShowtimeMovie(node) {
  if (!node || typeof node !== 'object' || node.episodeNumber != null) return false;
  const typeValues = [
    node.mediaType,
    node.type,
    node.contentType,
    node.videoType,
    node.assetType,
    node.productType,
    node.entityType,
    node.programmeType,
    node.programType,
    node.kind,
    node.subType,
  ];
  const hasRuntime = node.durationMilliseconds != null || node.durationSeconds != null;
  const hasFormats = Boolean(node.formats && typeof node.formats === 'object');
  const hasCreditMarkers = hasFormats && Object.values(node.formats).some(format => {
    const markers = format?.markers || {};
    return ['SOCR', 'EOCR', 'EOC', 'startOfCredits', 'creditsStart'].some(key => markers[key] != null || format?.[key] != null);
  });
  const hasMovieFlag = ['isMovie', 'isFilm', 'isFeature'].some(key =>
    node[key] === true || node[key] === 1 || node[key] === 'true'
  );
  return (typeValues.some(isSkyShowtimeMovieType) || hasMovieFlag || hasCreditMarkers) && (hasRuntime || hasFormats);
}

function extendSkyShowtimeContext(context, attributes) {
  if (!attributes || typeof attributes !== 'object') return context;
  const mediaType = attributes.mediaType || attributes.type || attributes.contentType || attributes.entityType || context.mediaType;
  return {
    seasonNumber: attributes.seasonNumber ?? context.seasonNumber,
    ...(mediaType ? { mediaType } : {}),
    providerSeriesId: attributes.providerSeriesId || context.providerSeriesId,
    providerVariantId: attributes.providerVariantId || context.providerVariantId,
    programmeUuid: attributes.programmeUuid || context.programmeUuid,
    providerMovieId: attributes.providerMovieId || context.providerMovieId,
    movieId: attributes.movieId || context.movieId,
    id: attributes.id || context.id,
    seriesId: attributes.seriesId || context.seriesId,
    seriesUuid: attributes.seriesUuid || context.seriesUuid,
    seriesName: attributes.seriesName || context.seriesName,
    movieName: attributes.movieName || context.movieName,
    titleLong: attributes.titleLong || context.titleLong,
    titleMedium: attributes.titleMedium || context.titleMedium,
    title: attributes.title || context.title,
    name: attributes.name || context.name,
    durationMilliseconds: attributes.durationMilliseconds ?? context.durationMilliseconds,
    durationSeconds: attributes.durationSeconds ?? context.durationSeconds,
    year: attributes.year ?? attributes.releaseYear ?? attributes.releaseDate?.slice?.(0, 4) ?? context.year,
  };
}

function getSkyShowtimeMovieIdentifiers(movie) {
  return [
    movie?.providerVariantId,
    movie?.programmeUuid,
    movie?.providerMovieId,
    movie?.movieId,
    movie?.id,
    movie?.contentId,
    movie?.catalogId,
  ].filter(value => value != null && String(value).trim() !== '').map(value => String(value).trim());
}

function getSkyShowtimeMovieId(movie) {
  return getSkyShowtimeMovieIdentifiers(movie)[0] || '';
}

function getSkyShowtimeRequestedVariantId(sourceUrl) {
  const match = String(sourceUrl || '').match(/\/provider_variant_id\/([^/?#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
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

/** Find explicitly typed movie records while inheriting catalogue context. */
function findSkyShowtimeMovies(root) {
  const found = [];
  const visited = new WeakSet();

  function walk(node, inheritedContext = {}) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, inheritedContext));
      return;
    }

    const hasAttributes = node.attributes && typeof node.attributes === 'object';
    const attributes = hasAttributes
      ? { ...node.attributes, ...(node.id != null && node.attributes.id == null ? { id: node.id } : {}) }
      : node;
    const context = extendSkyShowtimeContext(inheritedContext, attributes);
    const candidate = { ...context, ...attributes };
    if (looksLikeSkyShowtimeMovie(candidate)) {
      found.push({
        ...candidate,
        providerVariantId: attributes.providerVariantId || context.providerVariantId,
        seriesId: attributes.seriesId || context.seriesId,
        seriesUuid: attributes.seriesUuid || context.seriesUuid,
        seriesName: attributes.seriesName || context.seriesName,
        year: attributes.year ?? attributes.releaseYear ?? attributes.releaseDate?.slice?.(0, 4) ?? context.year,
      });
    }

    for (const value of Object.values(node)) walk(value, context);
  }

  walk(root);
  const movieKeys = new Set();
  return found.filter(movie => {
    const key = [
      getSkyShowtimeMovieId(movie) || movie.titleLong || movie.titleMedium || movie.title || 'movie',
      movie.year || '?',
    ].join('::');
    if (movieKeys.has(key)) return false;
    movieKeys.add(key);
    return true;
  });
}

function getSkyShowtimeFormat(episode) {
  const formats = episode?.formats;
  if (!formats || typeof formats !== 'object') return null;
  const candidates = [formats.HD, formats.UHDSDR, ...Object.values(formats)]
    .filter(format => format && typeof format === 'object');
  const directMarkerKeys = [
    'SOI', 'EOI', 'SOR', 'EOR', 'SOCR', 'EOCR', 'EOC',
    'startOfCredits', 'creditsStart', 'endOfCredits', 'creditsEnd',
  ];
  const hasMarkers = format =>
    Boolean(format.markers && typeof format.markers === 'object' && Object.keys(format.markers).length) ||
    directMarkerKeys.some(key => format[key] != null);
  return candidates.find(hasMarkers) || candidates[0] || null;
}

function firstSkyShowtimeMarkerValue(markers, format, keys) {
  for (const key of keys) {
    const value = coerceSkyShowtimeNumber(markers?.[key] ?? format?.[key]);
    if (value != null) return value;
  }
  return null;
}

function getSkyShowtimeMovieCreditRange(movie, format) {
  const markers = format?.markers || {};
  const startMs = firstSkyShowtimeMarkerValue(markers, format, [
    'SOCR',
    'startOfCredits',
    'creditsStart',
    'creditsStartMs',
  ]);
  let endMs = firstSkyShowtimeMarkerValue(markers, format, [
    'EOCR',
    'EOC',
    'endOfCredits',
    'creditsEnd',
    'creditsEndMs',
  ]);
  const afterCreditsStartMs = firstSkyShowtimeMarkerValue(markers, format, [
    'SOAC',
    'SOAfterCredits',
    'afterCreditsStart',
    'afterCreditsStartMs',
    'postCreditsStart',
    'postCreditsStartMs',
  ]);
  const afterCreditsEndMs = firstSkyShowtimeMarkerValue(markers, format, [
    'EOAC',
    'EOAfterCredits',
    'afterCreditsEnd',
    'afterCreditsEndMs',
    'postCreditsEnd',
    'postCreditsEndMs',
  ]);
  const afterCreditsDetected = afterCreditsStartMs != null || afterCreditsEndMs != null || [
    markers.afterCredits,
    markers.afterCreditsScene,
    markers.postCredits,
    markers.postCreditsScene,
    format?.afterCredits,
    format?.afterCreditsScene,
    format?.postCredits,
    format?.postCreditsScene,
  ].some(value => value === true || (value && typeof value === 'object'));

  const durationMilliseconds = [
    movie.durationMilliseconds,
    movie.durationMs,
    format?.durationMilliseconds,
    format?.durationMs,
  ].map(coerceSkyShowtimeNumber).find(value => value != null) ?? null;
  const durationSeconds = [
    movie.durationSeconds,
    movie.runtimeSeconds,
    format?.durationSeconds,
    format?.runtimeSeconds,
  ].map(coerceSkyShowtimeNumber).find(value => value != null) ?? null;
  const durationMs = durationMilliseconds ?? (durationSeconds == null ? null : durationSeconds * 1000);
  if (endMs == null) endMs = durationMs;
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  if (durationMs != null) {
    if (startMs >= durationMs) return null;
    endMs = Math.min(endMs, durationMs);
  }
  if (endMs <= startMs) return null;
  return { startMs, endMs, durationMs, afterCreditsStartMs, afterCreditsEndMs, afterCreditsDetected };
}

// Preserve numeric timing metadata only, never playback URLs or credentials.
function skyShowtimeTimingFields(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'boolean') result[key] = entry;
    else if (coerceSkyShowtimeNumber(entry) != null) result[key] = coerceSkyShowtimeNumber(entry);
    else if (entry && typeof entry === 'object') {
      const nested = skyShowtimeTimingFields(entry, depth + 1);
      if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}

function recordSkyShowtimeMovieDiagnostic(movie, format, creditRange, reasons) {
  const timingKeys = /^(?:duration|runtime|startOfCredits|endOfCredits|credits|afterCredits|postCredits|SO|EO)/i;
  const selectTiming = source => Object.fromEntries(Object.entries(source || {})
    .filter(([key]) => timingKeys.test(key)));
  const entry = {
    movieId: getSkyShowtimeMovieId(movie),
    title: movie.titleLong || movie.titleMedium || movie.movieName || movie.title || movie.name || '',
    runtime: skyShowtimeTimingFields(selectTiming(movie)),
    formats: Object.fromEntries(Object.entries(movie.formats || {}).map(([name, candidate]) => [name, {
      selected: candidate === format,
      fields: skyShowtimeTimingFields(selectTiming(candidate)),
      markers: skyShowtimeTimingFields(candidate?.markers),
    }])),
    selectedRangeMs: creditRange,
    sceneStatus: creditRange?.afterCreditsDetected ? 'provider-marker-present' : 'unknown',
    reviewReasons: reasons,
  };
  state.skyShowtimeMovieDiagnostics ||= [];
  const signature = JSON.stringify(entry);
  if (!state.skyShowtimeMovieDiagnostics.some(previous => JSON.stringify(previous) === signature)) {
    state.skyShowtimeMovieDiagnostics.push(entry);
    if (state.skyShowtimeMovieDiagnostics.length > 100) state.skyShowtimeMovieDiagnostics.shift();
    console.info('[SSE] Movie marker diagnostic', entry);
  }
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

function addSkyShowtimeSegment(extractedItems, common, providerSegmentType, startMs, endMs, mediaType = 'tv', creditPart = null) {
  if (startMs == null || endMs == null || endMs <= startMs) return;
  const isMovie = String(mediaType).toLowerCase() === 'movie';
  const partSuffix = creditPart ? `::${creditPart}` : '';
  const episodeId = `${common.episodeId}${isMovie ? '::movie' : ''}::${providerSegmentType}${partSuffix}`;
  const isDuplicate = item => item._eid === episodeId || (
    item._showId === common.showId &&
    String(item.media_type || 'tv').toLowerCase() === String(mediaType).toLowerCase() &&
    item.season === common.season &&
    item.episode === common.episode &&
    item.segment_type === providerSegmentType &&
    (item.credit_part || null) === (creditPart || null)
  );
  const sameRange = item => item.start_sec === roundSkyShowtimeSeconds(startMs / 1000) && item.end_sec === roundSkyShowtimeSeconds(endMs / 1000);
  if (extractedItems.some(item => isDuplicate(item) && sameRange(item))) return;
  const previous = state.allItems.find(item => isDuplicate(item) && (isMovie || sameRange(item)));
  if (previous) {
    if (!isMovie || (previous.start_sec === roundSkyShowtimeSeconds(startMs / 1000)
      && previous.end_sec === roundSkyShowtimeSeconds(endMs / 1000))) return;
    state.allItems = state.allItems.filter(item => !isDuplicate(item));
  }
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: common.episodeTitle,
    _showId: common.showId,
    ...(isMovie ? { media_type: 'movie' } : {}),
    ...(creditPart ? { credit_part: creditPart } : {}),
    imdb_id: state.imdbIdsByShowId?.[common.showId] || 'IMDB_PENDING',
    segment_type: providerSegmentType,
    season: common.season,
    episode: common.episode,
    start_sec: roundSkyShowtimeSeconds(startMs / 1000),
    end_sec: roundSkyShowtimeSeconds(endMs / 1000),
    _timing: { provider: 'skyshowtime', source: 'catalogue-marker', unit: 'milliseconds', raw_start: startMs, raw_end: endMs },
  });
}

/** Parse SOI/EOI, SOR/EOR and SOCR/runtime markers from a catalogue response. */
function processSkyShowtimeMetadata(data, sourceUrl = '') {
  const episodes = findSkyShowtimeEpisodes(data);
  const discoveredMovies = findSkyShowtimeMovies(data);
  const requestedVariantId = getSkyShowtimeRequestedVariantId(sourceUrl);
  const movies = requestedVariantId
    ? discoveredMovies.filter(movie => getSkyShowtimeMovieIdentifiers(movie).some(id => id === requestedVariantId))
    : discoveredMovies;
  if (!episodes.length && !movies.length) return 0;

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

  for (const movie of movies) {
    const movieId = getSkyShowtimeMovieId(movie) || movie.titleLong || movie.titleMedium || movie.title;
    const movieTitle = movie.titleLong || movie.titleMedium || movie.movieName || movie.title || movie.name || '';
    if (!movieId || !movieTitle) continue;
    handleDetectedShow({
      title: movieTitle,
      showId: String(movieId),
      year: movie.year || '',
      mediaType: 'movie',
    });
  }

  if (episodes.length) setProviderEpisodeCatalog(episodes.flatMap(episode => {
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

  for (const movie of movies) {
    const movieId = getSkyShowtimeMovieId(movie) || movie.titleLong || movie.titleMedium || movie.title;
    const movieTitle = movie.titleLong || movie.titleMedium || movie.movieName || movie.title || movie.name || '';
    const format = getSkyShowtimeFormat(movie);
    const creditRange = getSkyShowtimeMovieCreditRange(movie, format);
    const reasons = [];
    if (!creditRange) reasons.push('No complete credits range in the selected format.');
    const durationMs = creditRange?.durationMs ?? creditRange?.endMs;
    // This is a review heuristic, not a new definition of the credits start.
    if (creditRange && durationMs - creditRange.startMs <= 10000) {
      reasons.push('Credits marker is within the final 10 seconds; verify the first credits in playback.');
    }
    recordSkyShowtimeMovieDiagnostic(movie, format, creditRange, reasons);
    if (reasons.length) {
      const countBefore = state.allItems.length;
      state.allItems = state.allItems.filter(item => !(item.media_type === 'movie' && item._showId === String(movieId)));
      if (state.allItems.length !== countBefore) updateCounters();
      console.warn('[SSE] Movie timestamps withheld for review:', movieTitle, reasons);
      continue;
    }
    if (!movieId || !movieTitle || !creditRange) continue;

    const common = {
      episodeId: String(movieId),
      episodeTitle: movieTitle,
      showId: String(movieId),
      season: null,
      episode: null,
    };
    const movieItems = [];
    const ranges = splitCreditRange({
      startSec: creditRange.startMs / 1000,
      endSec: creditRange.endMs / 1000,
      runtimeSec: creditRange.durationMs == null ? null : creditRange.durationMs / 1000,
      afterCreditsDetected: creditRange.afterCreditsDetected,
      afterCreditsStartSec: creditRange.afterCreditsStartMs == null ? null : creditRange.afterCreditsStartMs / 1000,
      afterCreditsEndSec: creditRange.afterCreditsEndMs == null ? null : creditRange.afterCreditsEndMs / 1000,
    });
    for (const range of ranges) {
      addSkyShowtimeSegment(
        movieItems,
        common,
        range.segmentType || 'outro',
        range.startSec * 1000,
        range.endSec * 1000,
        'movie',
        range.creditPart
      );
    }
    extractedItems.push(...movieItems);
    logCapturedTimestamps({
      prefix: 'SSE',
      showTitle: movieTitle,
      mediaType: 'movie',
      episodeTitle: movieTitle,
      providerIdLabel: 'providerVariantId',
      providerId: movieId,
      items: movieItems,
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
  const variantPath = JSON.stringify(SKYSHOWTIME_VARIANT_PATH);
  const messageKey = JSON.stringify(SKYSHOWTIME_WORKER_MESSAGE);
  const importStatement = isModule
    ? `import(${JSON.stringify(originalUrl)});`
    : `importScripts(${JSON.stringify(originalUrl)});`;
  return `
    (() => {
      const messageKey = ${messageKey};
      const isTarget = url => {
        const value = String(url || '');
        return value.includes(${targetHost}) && value.includes(${targetPath}) &&
          (value.includes(${seriesPath}) || value.includes(${variantPath}));
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
  const inFlightUrls = new Set();
  const originalFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;

  const processCapturedMetadata = (data, url, via) => {
    if (url) {
      inFlightUrls.delete(url);
      fetchedUrls.add(url);
    }
    try {
      processSkyShowtimeMetadata(data, `${via}: ${url}`);
    } catch (error) {
      console.error('[SSE] Failed to process SkyShowtime catalogue metadata:', error);
    }
  };

  if (originalFetch) {
    win.fetch = function (input, init) {
      const url = getSkyShowtimeRequestUrl(input);
      if (!isSkyShowtimeCatalogueUrl(url)) return originalFetch(input, init);

      inFlightUrls.add(url);
      return originalFetch(input, init).then(response => {
        response.clone().json()
          .then(data => processCapturedMetadata(data, url, 'page-fetch'))
          .catch(error => {
            inFlightUrls.delete(url);
            console.warn('[SSE] Failed to read page fetch response:', error);
            refetchCatalogue(url);
          });
        return response;
      }, error => {
        inFlightUrls.delete(url);
        throw error;
      });
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
          inFlightUrls.add(url);
          xhr.addEventListener('load', () => {
            try { processCapturedMetadata(JSON.parse(xhr.responseText), url, 'page-xhr'); }
            catch (error) {
              inFlightUrls.delete(url);
              console.warn('[SSE] Failed to read page XHR response:', error);
              refetchCatalogue(url);
            }
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

  function refetchCatalogue(url) {
    if (!isSkyShowtimeCatalogueUrl(url) || fetchedUrls.has(url) || inFlightUrls.has(url)) return;
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
  }

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

/** SkyShowtime provider registration. */


bootstrapProvider({
  providerName: 'skyshowtime',
  setupInterception: setupSkyShowtimeInterception,
  isPlayerPage: isSkyShowtimePlayerPage,
});
  }
})();
