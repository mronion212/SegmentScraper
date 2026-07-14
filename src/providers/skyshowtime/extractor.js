/**
 * SkyShowtime extraction scaffold.
 *
 * The provider is registered so its panel and trigger are available during
 * playback. Network response shapes still need to be mapped before segment
 * timestamps can be captured.
 */

export function isSkyShowtimePlayerPage() {
  return Boolean(document.querySelector('video'));
}

export function setupSkyShowtimeInterception() {
  console.info('[SSE] SkyShowtime provider initialized; segment extraction is not mapped yet.');
}
