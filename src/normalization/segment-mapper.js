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

/** Labels used when a movie's credits are split around an after-credits scene. */
export const CREDIT_PARTS = {
  BEFORE_AFTER_CREDITS_SCENE: 'before_after_credits_scene',
  AFTER_AFTER_CREDITS_SCENE: 'after_after_credits_scene',
};

/**
 * Split a movie credit range around a provider-reported after-credits scene.
 *
 * The scene itself is deliberately omitted. If its end is unknown, only the
 * safe part before the scene is returned; guessing the post-scene start would
 * risk including the scene in the credits segment.
 */
export function splitCreditRange({
  startSec,
  endSec,
  afterCreditsStartSec = null,
  afterCreditsEndSec = null,
  afterCreditsDetected = false,
}) {
  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return [];

  const sceneStart = afterCreditsStartSec == null ? null : Number(afterCreditsStartSec);
  const sceneEnd = afterCreditsEndSec == null ? null : Number(afterCreditsEndSec);
  const hasScene = afterCreditsDetected || Number.isFinite(sceneStart) || Number.isFinite(sceneEnd);

  if (!hasScene) return [{ startSec: start, endSec: end, creditPart: null }];
  if (!Number.isFinite(sceneStart)) return [];

  // If all credits finish before the scene, they are still the pre-scene
  // portion and should remain clearly labelled as such.
  if (sceneStart >= end) return [{
    startSec: start,
    endSec: end,
    creditPart: CREDIT_PARTS.BEFORE_AFTER_CREDITS_SCENE,
  }];
  if (sceneStart <= start) return [];

  const parts = [{
    startSec: start,
    endSec: sceneStart,
    creditPart: CREDIT_PARTS.BEFORE_AFTER_CREDITS_SCENE,
  }];

  // Without a trustworthy scene end there is no safe post-scene range.
  if (!Number.isFinite(sceneEnd) || sceneEnd <= sceneStart) return parts;
  const postSceneStart = Math.min(sceneEnd, end);
  if (postSceneStart < end) {
    parts.push({
      startSec: postSceneStart,
      endSec: end,
      creditPart: CREDIT_PARTS.AFTER_AFTER_CREDITS_SCENE,
    });
  }
  return parts;
}

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
 * @param {string} [params.showId] - Provider series identifier used to isolate multiple series
 * @param {string} [params.episodeTitle] - Provider episode title used only for TVDB mapping
 * @param {string} [params.mediaType] - Media type, currently `tv` or `movie`
 * @param {string} [params.creditPart] - Movie credit part around an after-credits scene
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
  showId = '',
  episodeTitle = '',
  mediaType = 'tv',
  creditPart = null,
}) {
  const segmentType = normalizeSegmentType(providerSegmentType, providerName);
  if (!segmentType) return null;
  
  return {
    _eid: episodeId,
    _episodeTitle: episodeTitle,
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
export function getProviderSegmentTypes(providerName) {
  const mappings = PROVIDER_MAPPINGS[providerName.toLowerCase()] || {};
  return [...new Set(Object.values(mappings))];
}
