/**
 * Shared network utilities for SegmentScraper
 * Handles API requests, IMDb lookups, and IntroDB integration
 */

import { state, createMediaCacheKey } from './state.js';
import { introdbPayload, parseIntrodbSegments } from './output-policy.js';

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
export async function searchImdbByTitle(title, year, { mediaType = 'tv' } = {}) {
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
export async function loadExistingSegments(imdbId, apiKey) {
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
export async function loadExistingSegmentsForEpisode(key, apiKey, { useCache = true, writeCache = true } = {}) {
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
export async function submitSegment(item, apiKey) {
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
export async function lookupImdbTitle(imdbId) {
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
