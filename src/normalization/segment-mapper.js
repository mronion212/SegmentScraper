/**
 * Segment type normalization layer
 * Maps provider-specific segment names to shared internal format
 */

/**
 * Standard internal segment types
 */
export const SEGMENT_TYPES = {
  INTRO: 'intro',
  RECAP: 'recap',
  OUTRO: 'outro',
};

/**
 * Provider-specific segment name mappings
 * Each provider can have different names for the same segment types
 */
export const PROVIDER_MAPPINGS = {
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
export function normalizeSegmentType(providerSegmentType, providerName) {
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
export function createNormalizedSegment({
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
export function getProviderSegmentTypes(providerName) {
  const mappings = PROVIDER_MAPPINGS[providerName.toLowerCase()] || {};
  return [...new Set(Object.values(mappings))];
}
