/**
 * Shared state management for SegmentScraper
 * Manages captured timestamps, UI state, and deduplication cache
 */

export const createState = (providerName) => ({
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
  existingSegments: new Set(),
  existingSegmentsLoaded: false,
  dedupCacheV2: {},
  introdbApiKey: '',
});

export const state = createState('Streaming Service');