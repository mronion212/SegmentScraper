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
 * Create a cache key for either a TV episode or a movie.
 * Movies intentionally omit season/episode because they do not use TVDB.
 */
export function createMediaCacheKey(imdbId, mediaType = 'tv', season, episode) {
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
export function createSegmentCacheKey(imdbId, season, episode, segmentType) {
  return `${String(imdbId)}|${String(season)}|${String(episode)}|${segmentType}`;
}

export const createState = (providerName) => ({
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

export const state = createState('Streaming Service');
