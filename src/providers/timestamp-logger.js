/** Shared, provider-agnostic logging for newly captured episode timestamps. */

/** Format seconds as mm:ss.mmm, adding hours only when needed. */
export function formatCapturedTimestamp(seconds) {
  const numericSeconds = Number(seconds);
  if (!Number.isFinite(numericSeconds)) return '';

  const totalMilliseconds = Math.max(0, Math.round(numericSeconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const remainingSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const clock = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock;
}

/** Log one episode in the same structured shape for every provider. */
export function logCapturedTimestamps({
  prefix,
  showTitle,
  season,
  episode,
  episodeTitle = '',
  providerIdLabel = 'providerId',
  providerId = '',
  items = [],
}) {
  if (!items.length) return;

  const episodeLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const details = {
    title: episodeTitle || '',
    ...(providerId != null && providerId !== '' ? { [providerIdLabel]: providerId } : {}),
    segments: items.map(item => ({
      type: item.segment_type,
      start: formatCapturedTimestamp(item.start_sec),
      end: formatCapturedTimestamp(item.end_sec),
      start_sec: item.start_sec,
      end_sec: item.end_sec,
    })),
  };
  console.info(`[${prefix}] Captured timestamps · ${showTitle || 'Unknown series'} · ${episodeLabel}`, details);
}
