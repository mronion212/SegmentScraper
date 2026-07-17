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
export function createEpisodeCacheKey(imdbId, season, episode) {
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
export function createSegmentCacheKey(imdbId, season, episode, segmentType) {
  return `${String(imdbId)}|${String(season)}|${String(episode)}|${segmentType}`;
}

export const createState = (providerName) => ({
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

export const state = createState('Streaming Service');
