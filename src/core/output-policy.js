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
  return JSON.stringify([String(item._showId || ''), String(item._eid), item.season, item.episode, item.segment_type, Number(item.start_sec), Number(item.end_sec)]);
}
export function outputSegmentAllowed(item) {
  const movie = isMovieSegment(item);
  const start=Number(item?.start_sec),end=Number(item?.end_sec);
  return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end-start>=5&&(!movie||(['outro','post-credits'].includes(item.segment_type)&&end-start<=(item.segment_type==='outro'?900:600)));
}
export function introdbPayload(item) {
  const movie = isMovieSegment(item);
  return {imdb_id:item.imdb_id,segment_type:item.segment_type,start_sec:item.start_sec,end_sec:item.end_sec,...(movie?{is_movie:true}:{season:item.season,episode:item.episode})};
}

/** IntroDB stores boundaries in milliseconds. */
export function sameIntrodbRange(a, b) {
  return normalizeIntrodbSegmentType(a.segment_type) === normalizeIntrodbSegmentType(b.segment_type)
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
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function introdbRangeValue(source, secondsKeys, millisecondsKey) {
  for (const key of secondsKeys) {
    if (source?.[key] != null) return introdbSeconds(source[key]);
  }
  if (source?.[millisecondsKey] != null) return Number(source[millisecondsKey]) / 1000;
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
