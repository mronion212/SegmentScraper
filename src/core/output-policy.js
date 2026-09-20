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
