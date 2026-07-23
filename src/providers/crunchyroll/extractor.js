/** Crunchyroll page metadata and skip-event extraction. */

import { state } from '../../core/state.js';
import { createNormalizedSegment } from '../../normalization/segment-mapper.js';
import { recordProviderEpisode } from '../../core/tvdb.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';

const CRUNCHYROLL_SKIP_EVENTS_BASE = 'https://static.crunchyroll.com/skip-events/production';
const CRUNCHYROLL_SCAN_INTERVAL_MS = 750;

function ensureCrunchyrollState() {
  if (!(state.crunchyrollRegisteredEpisodes instanceof Set)) state.crunchyrollRegisteredEpisodes = new Set();
  if (!(state.crunchyrollRequestedWatchIds instanceof Set)) state.crunchyrollRequestedWatchIds = new Set();
}

function coerceCrunchyrollInteger(value, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  return number > 0 || (allowZero && number === 0) ? number : null;
}

function hasSchemaType(item, type) {
  const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
  return types.includes(type);
}

function flattenStructuredData(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach(item => flattenStructuredData(item, output));
    return output;
  }
  output.push(value);
  if (Array.isArray(value['@graph'])) flattenStructuredData(value['@graph'], output);
  return output;
}

function extractCrunchyrollSeriesId(value) {
  const match = String(value || '').match(/\/series\/([A-Z0-9]+)/i);
  return match ? match[1].toUpperCase() : null;
}

function normalizeCrunchyrollEpisodeTitle(value, episodeNumber) {
  const title = String(value || '').trim();
  if (!title) return '';
  return title
    .replace(/^.*?\|\s*E(?:pisode\s*)?\d+(?:\.\d+)?\s*[-:|]\s*/i, '')
    .replace(new RegExp(`^E(?:pisode\\s*)?${episodeNumber}\\s*[-:|]\\s*`, 'i'), '')
    .trim();
}

/** Return the Crunchyroll watch identifier from normal and localized player paths. */
export function getCrunchyrollWatchId(pathname = location.pathname) {
  const match = String(pathname || '').match(/(?:^|\/)watch\/([A-Z0-9]+)(?:\/|$)/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Read the current episode from Crunchyroll's server-rendered schema.org data.
 * Keeping this independent of player internals makes it work before playback
 * starts and across both the legacy and current web players.
 */
export function readCrunchyrollPageMetadata(doc = document, pathname = location.pathname) {
  const watchId = getCrunchyrollWatchId(pathname);
  if (!watchId || !doc?.querySelectorAll) return null;

  const structuredData = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { flattenStructuredData(JSON.parse(script.textContent || ''), structuredData); }
    catch (_) {}
  }

  const episodeData = structuredData.find(item => {
    if (!hasSchemaType(item, 'TVEpisode')) return false;
    const itemWatchId = getCrunchyrollWatchId(item['@id'] || item.url || '');
    return !itemWatchId || itemWatchId === watchId;
  });
  if (!episodeData) return null;

  const season = coerceCrunchyrollInteger(episodeData.partOfSeason?.seasonNumber, { allowZero: true });
  const episode = coerceCrunchyrollInteger(episodeData.episodeNumber);
  const seriesUrl = episodeData.partOfSeries?.['@id'] || episodeData.partOfSeason?.['@id'];
  const showId = extractCrunchyrollSeriesId(seriesUrl);
  const seriesTitle = String(episodeData.partOfSeries?.name || '').trim();
  if (!showId || !seriesTitle || season == null || episode == null) return null;

  const videoData = structuredData.find(item => hasSchemaType(item, 'VideoObject'));
  const episodeTitle = normalizeCrunchyrollEpisodeTitle(
    videoData?.name || episodeData.name,
    episode
  );
  const publishedYear = String(episodeData.datePublished || '').match(/^(\d{4})/);
  const seasonLabel = String(episodeData.partOfSeason?.name || '').trim().toLowerCase();

  return {
    watchId,
    providerId: watchId,
    showId,
    seriesTitle,
    season,
    episode,
    episodeTitle,
    year: season === 1 ? publishedYear?.[1] || '' : '',
    isSpecial: season === 0 || /\b(?:specials?|extras?|bonus|trailers?)\b/.test(seasonLabel),
  };
}

function registerCrunchyrollEpisode(metadata) {
  ensureCrunchyrollState();
  handleDetectedShow({
    title: metadata.seriesTitle,
    showId: metadata.showId,
    year: metadata.year,
  });

  const registrationKey = `${metadata.showId}|${metadata.season}|${metadata.episode}`;
  if (state.crunchyrollRegisteredEpisodes.has(registrationKey)) return;
  state.crunchyrollRegisteredEpisodes.add(registrationKey);
  recordProviderEpisode({
    providerId: metadata.providerId || metadata.watchId,
    season: metadata.season,
    episode: metadata.episode,
    title: metadata.episodeTitle,
    isSpecial: metadata.isSpecial,
  }, metadata.showId);
}

function addCrunchyrollSegment(extractedItems, metadata, skipEvents, providerSegmentType, marker) {
  const startSec = Number(marker?.start);
  const endSec = Number(marker?.end);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) return;

  const mediaId = skipEvents?.mediaId || metadata.providerId || metadata.watchId;
  const episodeId = `${mediaId}:${providerSegmentType}`;
  const normalizedType = providerSegmentType === 'credits' ? 'outro' : providerSegmentType;
  const isDuplicate = item => item._eid === episodeId || (
    String(item._showId || '') === String(metadata.showId) &&
    item.season === metadata.season &&
    item.episode === metadata.episode &&
    item.segment_type === normalizedType
  );
  if (state.allItems.some(isDuplicate) || extractedItems.some(isDuplicate)) return;

  const item = createNormalizedSegment({
    providerName: 'crunchyroll',
    providerSegmentType,
    episodeId,
    showId: metadata.showId,
    season: metadata.season,
    episode: metadata.episode,
    imdbId: state.imdbIdsByShowId?.[metadata.showId] || 'IMDB_PENDING',
    episodeTitle: metadata.episodeTitle,
    startSec,
    endSec,
  });
  if (!item) return;
  item._tvdbEpisodeLanguages = ['eng'];
  item._tvdbRequireTitleMatch = true;
  extractedItems.push(item);
}

/** Register one episode and normalize its public Crunchyroll skip-event payload. */
export function processCrunchyrollEpisode(metadata, skipEvents = {}) {
  if (!metadata?.showId || !metadata?.seriesTitle) return 0;
  if (coerceCrunchyrollInteger(metadata.season, { allowZero: true }) == null || coerceCrunchyrollInteger(metadata.episode) == null) return 0;
  registerCrunchyrollEpisode(metadata);

  const extractedItems = [];
  addCrunchyrollSegment(extractedItems, metadata, skipEvents, 'recap', skipEvents.recap);
  addCrunchyrollSegment(extractedItems, metadata, skipEvents, 'intro', skipEvents.intro);
  addCrunchyrollSegment(extractedItems, metadata, skipEvents, 'credits', skipEvents.credits);
  recordExtractedSegments(extractedItems);
  return extractedItems.length;
}

function getGmRequest() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) ||
    (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
    (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

function loadCrunchyrollSkipEvents(metadata, originalFetch) {
  const url = `${CRUNCHYROLL_SKIP_EVENTS_BASE}/${metadata.watchId}.json`;
  const gmRequest = getGmRequest();
  if (gmRequest) {
    gmRequest({
      method: 'GET',
      url,
      headers: { Accept: 'application/json, text/plain, */*' },
      timeout: 15000,
      onload: response => {
        if (response.status === 404) return;
        if (response.status < 200 || response.status >= 300) {
          console.warn(`[CRE] Skip-event request returned HTTP ${response.status}.`);
          return;
        }
        try { processCrunchyrollEpisode(metadata, JSON.parse(response.responseText)); }
        catch (error) { console.warn('[CRE] Failed to parse skip-event response:', error); }
      },
      onerror: () => console.warn('[CRE] Skip-event request failed.'),
      ontimeout: () => console.warn('[CRE] Skip-event request timed out.'),
    });
    return;
  }

  if (originalFetch) {
    originalFetch(url)
      .then(response => response.status === 404 ? null : response.json())
      .then(data => { if (data) processCrunchyrollEpisode(metadata, data); })
      .catch(error => console.warn('[CRE] Skip-event fetch failed:', error));
  }
}

export function isCrunchyrollPlayerPage() {
  return Boolean(getCrunchyrollWatchId(location.pathname));
}

export function setupCrunchyrollInterception() {
  ensureCrunchyrollState();
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const originalFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;

  const scanCurrentEpisode = () => {
    const metadata = readCrunchyrollPageMetadata(document, location.pathname);
    if (!metadata) return;
    processCrunchyrollEpisode(metadata);
    if (state.crunchyrollRequestedWatchIds.has(metadata.watchId)) return;
    state.crunchyrollRequestedWatchIds.add(metadata.watchId);
    loadCrunchyrollSkipEvents(metadata, originalFetch);
  };

  scanCurrentEpisode();
  document.addEventListener('DOMContentLoaded', scanCurrentEpisode, { once: true });
  setInterval(scanCurrentEpisode, CRUNCHYROLL_SCAN_INTERVAL_MS);
}
