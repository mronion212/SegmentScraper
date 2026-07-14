/**
 * Shared network utilities for SegmentScraper
 * Handles API requests, IMDb lookups, and IntroDB integration
 */

import { state, createEpisodeCacheKey } from './state.js';

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
export async function searchImdbByTitle(title, year, apiKey) {
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
export async function loadExistingSegments(imdbId, apiKey) {
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
export async function loadExistingSegmentsForEpisode(key, apiKey) {
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
export async function submitSegment(item, apiKey) {
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