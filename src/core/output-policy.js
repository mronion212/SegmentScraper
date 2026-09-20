/** Shared wire format and timing rules for both clients. Client-specific scene policy stays explicit. */
export function capturedSegmentKey(item) {
  return JSON.stringify([String(item._showId || ''), String(item._eid), item.season, item.episode, item.segment_type, Number(item.start_sec), Number(item.end_sec)]);
}
export function outputSegmentAllowed(item) {
  const movie=item?.is_movie===true||String(item?.media_type||item?.mediaType||item?._mediaType||'').toLowerCase()==='movie';
  const start=Number(item?.start_sec),end=Number(item?.end_sec);
  return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end-start>=5&&(!movie||(['outro','post-credits'].includes(item.segment_type)&&end-start<=(item.segment_type==='outro'?900:600)));
}
export function introdbPayload(item) {
  const movie=item?.is_movie===true||String(item?.media_type||item?.mediaType||item?._mediaType||'').toLowerCase()==='movie';
  return {imdb_id:item.imdb_id,segment_type:item.segment_type,start_sec:item.start_sec,end_sec:item.end_sec,...(movie?{is_movie:true}:{season:item.season,episode:item.episode})};
}
