/** Shared wire format and timing rules for both clients. Client-specific scene policy stays explicit. */
export function isMovieSegment(item) {
  return item?.is_movie === true || String(item?.media_type || item?.mediaType || item?._mediaType || '').toLowerCase() === 'movie';
}

/**
 * Movie credit extraction is intentionally enabled only for Netflix for now.
 * Other providers keep their TV extraction active while their movie markers
 * are being verified against real playback.
 */
export function movieCaptureAllowedForProvider(providerName) {
  return String(providerName || '').trim().toLowerCase() === 'netflix';
}

export function providerCaptureAllowed(item, providerName) {
  return !isMovieSegment(item) || movieCaptureAllowedForProvider(providerName);
}

export function capturedSegmentKey(item) {
  return JSON.stringify([String(item._showId || ''), String(item._eid), item.season, item.episode, item.segment_type, ...timestampRangeKey(item)]);
}

/** Reject missing/coerced values rather than turning null, blanks or booleans into zero. */
export function timestampNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function timestampRangeIssue(item, duration = item?._duration_sec) {
  const start = timestampNumber(item?.start_sec), end = timestampNumber(item?.end_sec);
  if (start === null || end === null || start < 0 || end <= start) return 'Invalid or missing timestamp boundaries';
  if (duration != null) {
    const limit = timestampNumber(duration);
    if (limit === null || limit <= 0 || end > limit) return 'Timestamp exceeds or has an invalid video duration';
  }
  return '';
}

export function timestampRangeKey(item) {
  return [item?.start_sec, item?.end_sec].map(value => {
    const number = timestampNumber(value);
    return number === null ? null : Math.round(number * 1000);
  });
}

/** Only numeric timing evidence and fixed labels belong in recovery, never requests or tokens. */
export function timestampEvidence({ provider, source, unit = 'seconds', rawStart, rawEnd, correction = 0 } = {}) {
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
export function validateManualIdentity({ imdbId, mediaType, season, episode, episodeTitle, segmentType }) {
  if (!/^tt\d{7,8}$/.test(imdbId || '')) throw new Error('Confirm a valid IMDb ID before marking timestamps.');
  if (!['tv', 'movie'].includes(mediaType)) throw new Error('Confirm the media type first.');
  if (!['intro', 'recap', 'outro'].includes(segmentType)) throw new Error('Choose Intro, Recap or Outro.');
  const movie = mediaType === 'movie';
  if (movie && segmentType !== 'outro') throw new Error('Online movie capture supports Outro only.');
  if (!movie && (![season, episode].every(value => Number.isInteger(value) && value > 0) || !String(episodeTitle || '').trim())) {
    throw new Error('Enter the playing episode’s season, episode number and actual title.');
  }
}

export function createManualSegment({ provider, showId, imdbId, mediaType, season, episode, episodeTitle, segmentType, start, end, duration }) {
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
export function assessTimestampCandidates(items) {
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

export function outputSegmentAllowed(item) {
  const movie = isMovieSegment(item);
  const start=Number(item?.start_sec),end=Number(item?.end_sec);
  return !timestampRangeIssue(item)&&['intro','recap','outro','post-credits'].includes(item.segment_type)&&end-start>=5&&(!movie||(['outro','post-credits'].includes(item.segment_type)&&end-start<=(item.segment_type==='outro'?900:600)));
}
export function introdbPayload(item) {
  const movie = isMovieSegment(item);
  return {imdb_id:item.imdb_id,segment_type:item.segment_type,start_sec:item.start_sec,end_sec:item.end_sec,...(movie?{is_movie:true}:{season:item.season,episode:item.episode})};
}

/** IntroDB stores boundaries in milliseconds. */
export function sameIntrodbRange(a, b) {
  return !timestampRangeIssue(a) && !timestampRangeIssue(b)
    && normalizeIntrodbSegmentType(a.segment_type) === normalizeIntrodbSegmentType(b.segment_type)
    && ['start_sec', 'end_sec'].every(key => a[key] != null && b[key] != null
      && Number.isFinite(Number(a[key])) && Number.isFinite(Number(b[key]))
      && Math.round(Number(a[key]) * 1000) === Math.round(Number(b[key]) * 1000));
}

export function uploadSegmentKey(item) {
  return JSON.stringify([item.imdb_id, isMovieSegment(item) ? 'movie' : [item.season, item.episode],
    normalizeIntrodbSegmentType(item.segment_type), Math.round(Number(item.start_sec)*1000), Math.round(Number(item.end_sec)*1000)]);
}

/**
 * Normalize the segment names used by the public IntroDB response.
 * IntroDB documents post-credits with a hyphen in the wire format, while
 * older responses and clients may expose the underscore variant.
 */
export function normalizeIntrodbSegmentType(segmentType) {
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
export function parseIntrodbSegments(response) {
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
export function introdbRangeEntries(response) {
  return parseIntrodbSegments(response).ranges;
}
