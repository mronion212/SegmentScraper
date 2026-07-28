/** Apple TV catalogue, HLS metadata, and timestamp extraction. */

import { state } from '../../core/state.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';
import { recordProviderEpisode } from '../../core/tvdb.js';
import { logCapturedTimestamps } from '../timestamp-logger.js';

const APPLE_TV_ID_PATTERN = /^umc\.cmc\.[a-z0-9]+$/i;
const APPLE_TV_CATALOG_PAGE_SIZE = 50;
const APPLE_TV_MAX_CATALOG_PAGES = 100;
const APPLE_TV_SERIALIZED_DATA_ID = 'serialized-server-data';
const APPLE_TV_HLS_PREFIX = 'com.apple.hls.';

let appleTvNativeFetch = null;
let appleTvUtsSession = null;
let appleTvCatalogRequestInFlight = false;
let appleTvPendingShowId = null;

function ensureAppleTvState() {
  if (!(state.appleTvEpisodesByCanonicalId instanceof Map)) state.appleTvEpisodesByCanonicalId = new Map();
  if (!(state.appleTvEpisodesByPlayableId instanceof Map)) state.appleTvEpisodesByPlayableId = new Map();
  if (!(state.appleTvEpisodesByManifestUrl instanceof Map)) state.appleTvEpisodesByManifestUrl = new Map();
  if (!(state.appleTvManifestRequests instanceof Set)) state.appleTvManifestRequests = new Set();
  if (!(state.appleTvCatalogShowIds instanceof Set)) state.appleTvCatalogShowIds = new Set();
}

function coerceAppleTvInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function coerceAppleTvSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readAppleTvShowId(url = typeof location === 'undefined' ? '' : location.href) {
  const raw = String(url || '');
  const match = raw.match(/\/show\/[^/?#]+\/(umc\.cmc\.[a-z0-9]+)/i);
  if (match?.[1]) return match[1];
  try {
    const queryShowId = new URL(raw, 'https://tv.apple.com/').searchParams.get('showId');
    return APPLE_TV_ID_PATTERN.test(String(queryShowId || '')) ? queryShowId : null;
  } catch (_) {
    return null;
  }
}

function readAppleTvEpisodeId(url = typeof location === 'undefined' ? '' : location.href) {
  const match = String(url || '').match(/\/episode\/[^/?#]+\/(umc\.cmc\.[a-z0-9]+)/i);
  return match?.[1] || null;
}

function readAppleTvPageTitle(root = document) {
  const heading = root.querySelector?.('[data-testid="product-header"] h1, main h1, h1');
  const headingText = String(heading?.textContent || '').trim();
  if (headingText) return headingText;
  return String(root.title || '')
    .replace(/^Apple TV\s*[+:\-]\s*/i, '')
    .replace(/\s*[|\-]\s*Apple TV.*$/i, '')
    .trim();
}

function updateAppleTvShow(title, showId) {
  const normalizedTitle = String(title || '').trim();
  const normalizedShowId = String(showId || '').trim();
  if (!normalizedTitle || !APPLE_TV_ID_PATTERN.test(normalizedShowId)) return false;
  if (state.showTitle === normalizedTitle && state.showId === normalizedShowId) return true;
  handleDetectedShow({ title: normalizedTitle, showId: normalizedShowId });
  return true;
}

function normalizeAppleTvManifestUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, typeof location === 'undefined' ? 'https://tv.apple.com/' : location.href);
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return raw;
  }
}

function normalizeAppleTvLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyAppleTvSkipLabel(label) {
  const normalized = normalizeAppleTvLabel(label);
  if (!normalized) return null;
  if (/(?:recap|recapitul|samenvatt|previously|previous episode|vorige aflevering|ruckblick|resumen|riassunto|anterior|precedemment)/i.test(normalized)) {
    return 'recap';
  }
  if (/(?:intro|opening|begintitel|opening credits|vorspann|apertura|cabecera|generique)/i.test(normalized)) {
    return 'intro';
  }
  return null;
}

function parseAppleTvHlsAttributes(line) {
  const attributes = {};
  const source = String(line || '').replace(/^#EXT-X-SESSION-DATA:?/i, '');
  const pattern = /(?:^|,)\s*([A-Z0-9-]+)=(?:"((?:\\.|[^"])*)"|([^,]*))/gi;
  let match;
  while ((match = pattern.exec(source))) {
    attributes[match[1].toUpperCase()] = String(match[2] ?? match[3] ?? '')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return attributes;
}

export function parseAppleTvHlsMetadata(manifestText) {
  const metadata = {};
  for (const line of String(manifestText || '').split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-SESSION-DATA')) continue;
    const attributes = parseAppleTvHlsAttributes(line);
    let key = attributes['DATA-ID'];
    const value = attributes.VALUE;
    if (!key || value == null) continue;
    if (key.startsWith(APPLE_TV_HLS_PREFIX)) key = key.slice(APPLE_TV_HLS_PREFIX.length);
    metadata[key] = value;
  }
  return metadata;
}

export function extractAppleTvMarkers(manifestText, durationSeconds = null) {
  const metadata = parseAppleTvHlsMetadata(manifestText);
  const markerCount = Number.parseInt(metadata['skip.count'], 10);
  const rawSkipMarkers = [];

  if (Number.isInteger(markerCount) && markerCount > 0) {
    for (let index = 0; index < markerCount; index++) {
      const prefix = `skip.${index}`;
      const start = coerceAppleTvSeconds(metadata[`${prefix}.start`]);
      const end = coerceAppleTvSeconds(metadata[`${prefix}.target`]);
      const label = String(metadata[`${prefix}.label`] || '').trim();
      const isPromo = metadata[`${prefix}.promo.enabled`] === 'true';
      if (start == null || end == null || end <= start || isPromo) continue;
      rawSkipMarkers.push({ index, start, end, label, type: classifyAppleTvSkipLabel(label) });
    }
  }

  const unresolved = rawSkipMarkers.filter(marker => !marker.type);
  if (unresolved.length === 1 && unresolved[0].end <= 10 * 60) unresolved[0].type = 'intro';
  if (unresolved.length > 1) {
    unresolved.forEach((marker, index) => {
      marker.type = index === 0 ? 'recap' : 'intro';
    });
  }

  const segments = rawSkipMarkers
    .filter(marker => marker.type)
    .map(marker => ({ type: marker.type, start: marker.start, end: marker.end, label: marker.label }));

  const outroStart = coerceAppleTvSeconds(metadata['up-next.start']);
  const durationCandidates = [
    coerceAppleTvSeconds(durationSeconds),
    coerceAppleTvSeconds(metadata['watched.time']),
  ].filter(value => value != null && (outroStart == null || value > outroStart));
  const outroEnd = durationCandidates.length ? Math.max(...durationCandidates) : null;
  if (outroStart != null && outroEnd != null && outroEnd > outroStart) {
    segments.push({ type: 'outro', start: outroStart, end: outroEnd, label: 'up-next' });
  }

  const seen = new Set();
  return segments.filter(segment => {
    if (seen.has(segment.type)) return false;
    seen.add(segment.type);
    return true;
  });
}

function logAppleTvTimestamps(episode, items) {
  logCapturedTimestamps({
    prefix: 'ATVE',
    showTitle: episode.showTitle || state.showTitle,
    season: episode.season,
    episode: episode.episode,
    episodeTitle: episode.episodeTitle,
    providerIdLabel: 'canonicalId',
    providerId: episode.canonicalId,
    items,
  });
}

function rememberAppleTvEpisode(episode) {
  ensureAppleTvState();
  const canonicalId = String(episode?.canonicalId || '').trim();
  const season = coerceAppleTvInteger(episode?.season);
  const episodeNumber = coerceAppleTvInteger(episode?.episode);
  const showId = String(episode?.showId || state.showId || '').trim();
  if (!APPLE_TV_ID_PATTERN.test(canonicalId) || season == null || episodeNumber == null) return null;

  const normalized = {
    canonicalId,
    playableId: String(episode.playableId || '').trim(),
    showId,
    showTitle: String(episode.showTitle || state.showTitle || '').trim(),
    season,
    episode: episodeNumber,
    episodeTitle: String(episode.episodeTitle || '').trim(),
    duration: coerceAppleTvSeconds(episode.duration),
  };
  state.appleTvEpisodesByCanonicalId.set(canonicalId, normalized);
  if (normalized.playableId) state.appleTvEpisodesByPlayableId.set(normalized.playableId, normalized);
  if (normalized.showTitle && normalized.showId) updateAppleTvShow(normalized.showTitle, normalized.showId);
  recordProviderEpisode({
    providerId: canonicalId,
    season,
    episode: episodeNumber,
    title: normalized.episodeTitle,
  }, showId);
  return normalized;
}

function resolveAppleTvEpisode(root, playable, showId) {
  const canonicalId = String(playable?.canonicalId || root?.id || '').trim();
  const canonical = playable?.canonicalMetadata || {};
  return rememberAppleTvEpisode({
    canonicalId,
    playableId: playable?.id,
    showId,
    showTitle: canonical.showTitle,
    season: root?.seasonNumber ?? canonical.seasonNumber,
    episode: root?.episodeNumber ?? canonical.episodeNumber,
    episodeTitle: root?.title ?? canonical.episodeTitle ?? playable?.title,
    duration: playable?.duration ?? root?.duration ?? canonical.duration,
  });
}

function findAppleTvEpisodeForManifest(url) {
  ensureAppleTvState();
  const normalizedUrl = normalizeAppleTvManifestUrl(url);
  const exact = state.appleTvEpisodesByManifestUrl.get(normalizedUrl);
  if (exact) return exact;
  const currentEpisodeId = readAppleTvEpisodeId();
  if (currentEpisodeId && state.appleTvEpisodesByCanonicalId.has(currentEpisodeId)) {
    return state.appleTvEpisodesByCanonicalId.get(currentEpisodeId);
  }
  return state.appleTvLastPlaybackEpisode || null;
}

export function processAppleTvHlsManifest(manifestText, url = '', explicitEpisode = null, playable = null) {
  ensureAppleTvState();
  if (!String(manifestText || '').includes('#EXT-X-SESSION-DATA')) return 0;
  const episode = explicitEpisode || findAppleTvEpisodeForManifest(url);
  if (!episode) return 0;
  const duration = playable?.duration ?? episode.duration;
  const markers = extractAppleTvMarkers(manifestText, duration);
  const items = [];

  for (const marker of markers) {
    const episodeId = `${episode.canonicalId}_${marker.type}`;
    const alreadyCaptured = item => item._eid === episodeId || (
      item._showId === episode.showId &&
      item.season === episode.season &&
      item.episode === episode.episode &&
      item.segment_type === marker.type
    );
    if (state.allItems.some(alreadyCaptured) || items.some(alreadyCaptured)) continue;
    items.push({
      _eid: episodeId,
      _episodeTitle: episode.episodeTitle,
      _showId: episode.showId,
      imdb_id: state.imdbIdsByShowId?.[episode.showId] || 'IMDB_PENDING',
      segment_type: marker.type,
      season: episode.season,
      episode: episode.episode,
      start_sec: marker.start,
      end_sec: marker.end,
    });
  }

  logAppleTvTimestamps(episode, items);
  recordExtractedSegments(items);
  return items.length;
}

function queueAppleTvManifest(url, episode, playable) {
  ensureAppleTvState();
  const normalizedUrl = normalizeAppleTvManifestUrl(url);
  if (!normalizedUrl || state.appleTvManifestRequests.has(normalizedUrl)) return false;
  state.appleTvManifestRequests.add(normalizedUrl);
  state.appleTvEpisodesByManifestUrl.set(normalizedUrl, episode);
  if (!appleTvNativeFetch) return false;

  appleTvNativeFetch(normalizedUrl, { credentials: 'include' })
    .then(response => response.text())
    .then(text => processAppleTvHlsManifest(text, normalizedUrl, episode, playable))
    .catch(error => {
      console.warn('[ATVE] Series-wide manifest fetch failed; waiting for per-episode playback:', episode.canonicalId, error);
    });
  return true;
}

function ingestAppleTvPlayable(playable, episodeRoot = null, showId = state.showId) {
  if (!playable || typeof playable !== 'object') return null;
  const episode = resolveAppleTvEpisode(episodeRoot, playable, showId);
  if (!episode) return null;
  const manifestUrl = playable.assets?.hlsUrl || playable.hlsUrl || '';
  if (manifestUrl) {
    state.appleTvLastPlaybackEpisode = episode;
    queueAppleTvManifest(manifestUrl, episode, playable);
  }
  return episode;
}

function findAppleTvCatalogNodes(root) {
  const found = [];
  const visited = new WeakSet();
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 9 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node.episodes) && node.playables && typeof node.playables === 'object') found.push(node);
    if (Array.isArray(node)) {
      node.forEach(value => walk(value, depth + 1));
      return;
    }
    Object.values(node).forEach(value => walk(value, depth + 1));
  }
  walk(root);
  return found;
}

function processAppleTvCatalogNode(catalog, showId) {
  const playables = catalog.playables || {};
  const episodePlayableMap = catalog.episodesPlayables || {};
  let manifestCount = 0;

  for (const episodeRoot of catalog.episodes || []) {
    const playableId = episodePlayableMap[episodeRoot.id]?.playableId || episodePlayableMap[episodeRoot.id]?.[0]?.playableId;
    const playable = playables[playableId] || Object.values(playables).find(item => item?.canonicalId === episodeRoot.id) || {};
    const episode = ingestAppleTvPlayable({ ...playable, canonicalId: playable.canonicalId || episodeRoot.id }, episodeRoot, showId);
    if (episode && (playable.assets?.hlsUrl || playable.hlsUrl)) manifestCount++;
  }
  return { episodeCount: catalog.episodes?.length || 0, manifestCount };
}

function scanAppleTvPlayableObjects(root, showId) {
  const visited = new WeakSet();
  let manifestCount = 0;
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 10 || visited.has(node)) return;
    visited.add(node);
    if (APPLE_TV_ID_PATTERN.test(String(node.canonicalId || '')) && (node.assets?.hlsUrl || node.hlsUrl)) {
      if (ingestAppleTvPlayable(node, null, showId)) manifestCount++;
    }
    if (Array.isArray(node)) {
      node.forEach(value => walk(value, depth + 1));
      return;
    }
    Object.values(node).forEach(value => walk(value, depth + 1));
  }
  walk(root);
  return manifestCount;
}

export function processAppleTvMetadata(payload, url = '', explicitShowId = null) {
  ensureAppleTvState();
  if (!payload || typeof payload !== 'object') return { episodeCount: 0, manifestCount: 0 };
  const root = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const showId = explicitShowId || readAppleTvShowId(url) || readAppleTvShowId() || state.showId;
  let episodeCount = 0;
  let manifestCount = 0;
  const catalogs = findAppleTvCatalogNodes(root);
  for (const catalog of catalogs) {
    const result = processAppleTvCatalogNode(catalog, showId);
    episodeCount += result.episodeCount;
    manifestCount += result.manifestCount;
  }
  if (!catalogs.length) manifestCount += scanAppleTvPlayableObjects(root, showId);
  return { episodeCount, manifestCount };
}

function getAppleTvUtsConfigurationEntry(root) {
  const entries = Array.isArray(root?.data) ? root.data : [];
  return entries.find(entry => entry?.intent?.$kind === 'UtsConfigureIntent')?.data || null;
}

function maybeStartAppleTvSeriesCapture() {
  const showId = state.showId || appleTvPendingShowId;
  if (!appleTvUtsSession || !showId || !appleTvNativeFetch || appleTvCatalogRequestInFlight) return;
  if (state.appleTvCatalogShowIds.has(showId)) return;
  appleTvCatalogRequestInFlight = true;
  fetchAppleTvSeriesCatalog(showId)
    .catch(error => console.warn('[ATVE] Series-wide fetch failed; falling back to per-episode playback:', error))
    .finally(() => { appleTvCatalogRequestInFlight = false; });
}

export function processAppleTvSerializedServerData(serialized) {
  ensureAppleTvState();
  let root = serialized;
  if (typeof serialized === 'string') {
    try { root = JSON.parse(serialized); }
    catch (_) { return false; }
  }
  if (!root || typeof root !== 'object') return false;

  const configurationEntry = getAppleTvUtsConfigurationEntry(root);
  if (configurationEntry?.configureParams && configurationEntry?.configuration) {
    appleTvUtsSession = configurationEntry;
  }
  const entries = Array.isArray(root.data) ? root.data : [];
  const showEntry = entries.find(entry => entry?.intent?.$kind === 'ShowPageIntent');
  const episodeEntry = entries.find(entry => entry?.intent?.$kind === 'EpisodePageIntent');
  const showId = showEntry?.intent?.id || episodeEntry?.intent?.showId || readAppleTvShowId();
  if (showId) appleTvPendingShowId = showId;
  if (showEntry) {
    const title = readAppleTvPageTitle() || showEntry.data?.seoData?.pageTitle;
    if (title && showId) updateAppleTvShow(title, showId);
  }
  processAppleTvMetadata(root, '', showId);
  maybeStartAppleTvSeriesCapture();
  return true;
}

function buildAppleTvUtsRequest(routeName, routeParams, queryOverrides = {}) {
  const configureParams = appleTvUtsSession?.configureParams;
  const configuration = appleTvUtsSession?.configuration;
  const route = configuration?.applicationProps?.routes?.[routeName];
  const requiredParams = configuration?.applicationProps?.requiredParamsMap?.[route?.requiredParamsType];
  if (!configureParams?.baseUrl || !configureParams?.developerToken || !route?.path || !requiredParams) return null;

  const consumed = new Set();
  const path = route.path.replace(/\{([\w-]+)\}/g, (match, key) => {
    if (routeParams[key] == null) return match;
    consumed.add(key);
    return encodeURIComponent(routeParams[key]);
  });
  if (/\{[\w-]+\}/.test(path)) return null;
  const url = new URL(`${String(configureParams.baseUrl).replace(/\/+$/, '')}${path}`);
  const query = { ...requiredParams, ...routeParams, ...queryOverrides };
  for (const [key, value] of Object.entries(query)) {
    if (consumed.has(key) || value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const headers = { Authorization: `Bearer ${configureParams.developerToken}` };
  if (configureParams.userToken) headers['Media-User-Token'] = configureParams.userToken;
  return { url: url.toString(), headers };
}

export async function fetchAppleTvSeriesCatalog(showId) {
  ensureAppleTvState();
  const normalizedShowId = String(showId || '').trim();
  if (!APPLE_TV_ID_PATTERN.test(normalizedShowId) || !appleTvNativeFetch) return { episodeCount: 0, manifestCount: 0 };

  let nextToken = '';
  let page = 0;
  let episodeCount = 0;
  let manifestCount = 0;
  let totalEpisodeCount = null;
  const seenEpisodeIds = new Set();

  do {
    const request = buildAppleTvUtsRequest('getShowEpisodes', { showId: normalizedShowId }, {
      includeSeasonSummary: true,
      selectedSeasonEpisodesOnly: false,
      ...(nextToken ? { nextToken } : {}),
    });
    if (!request) throw new Error('Apple TV UTS configuration is incomplete');
    const response = await appleTvNativeFetch(request.url, {
      method: 'GET',
      headers: request.headers,
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`Apple TV catalogue returned HTTP ${response.status}`);
    const payload = await response.json();
    const result = processAppleTvMetadata(payload, request.url, normalizedShowId);
    const pageEpisodeIds = findAppleTvCatalogNodes(payload?.data || payload)
      .flatMap(catalog => catalog.episodes || [])
      .map(episode => String(episode?.id || ''))
      .filter(Boolean);
    if (pageEpisodeIds.length) {
      pageEpisodeIds.forEach(id => seenEpisodeIds.add(id));
      episodeCount = seenEpisodeIds.size;
    } else {
      episodeCount += result.episodeCount;
    }
    manifestCount += result.manifestCount;
    const data = payload?.data || payload;
    totalEpisodeCount = coerceAppleTvInteger(data?.totalEpisodeCount) || totalEpisodeCount;
    nextToken = String(data?.nextToken || data?.episodesNextToken || '').trim();
    if (!nextToken && totalEpisodeCount && episodeCount < totalEpisodeCount) {
      nextToken = `${episodeCount}:${APPLE_TV_CATALOG_PAGE_SIZE}`;
    }
    page++;
  } while (nextToken && page < APPLE_TV_MAX_CATALOG_PAGES);

  state.appleTvCatalogShowIds.add(normalizedShowId);
  if (manifestCount) {
    console.info(`[ATVE] Series-wide timestamp fetch started for ${episodeCount} episode(s).`);
  } else {
    console.info(`[ATVE] Series catalogue captured for ${episodeCount} episode(s); timestamps will be fetched per episode during playback.`);
  }
  return { episodeCount, manifestCount };
}

function processAppleTvResponse(response, requestUrl = '') {
  const url = response?.url || requestUrl;
  const contentType = response?.headers?.get?.('content-type') || '';
  if (/\.m3u8(?:$|\?)/i.test(url) || /mpegurl/i.test(contentType)) {
    response.clone().text().then(text => processAppleTvHlsManifest(text, url)).catch(() => {});
    return;
  }
  if (/\/api\/uts\//i.test(url) || /json/i.test(contentType)) {
    response.clone().json().then(data => processAppleTvMetadata(data, url)).catch(() => {});
  }
}

function captureAppleTvSerializedNode(node) {
  if (!node) return false;
  if (node.nodeType === 1 && node.id === APPLE_TV_SERIALIZED_DATA_ID) {
    return processAppleTvSerializedServerData(node.textContent || '');
  }
  const nested = node.querySelector?.(`#${APPLE_TV_SERIALIZED_DATA_ID}`);
  return nested ? processAppleTvSerializedServerData(nested.textContent || '') : false;
}

function setupAppleTvSerializedDataObserver() {
  captureAppleTvSerializedNode(document.getElementById?.(APPLE_TV_SERIALIZED_DATA_ID));
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes || []) captureAppleTvSerializedNode(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

function setupAppleTvFetchInterception(win) {
  if (typeof win.fetch !== 'function') return;
  appleTvNativeFetch = win.fetch.bind(win);
  win.fetch = async function AppleTvInterceptedFetch(input, init) {
    const response = await appleTvNativeFetch(input, init);
    const requestUrl = typeof input === 'string' ? input : input?.url || '';
    processAppleTvResponse(response, requestUrl);
    return response;
  };
}

function setupAppleTvXhrInterception(win) {
  const OriginalXHR = win.XMLHttpRequest;
  if (typeof OriginalXHR !== 'function') return;
  win.XMLHttpRequest = function AppleTvInterceptedXHR() {
    const xhr = new OriginalXHR();
    let requestUrl = '';
    const originalOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      requestUrl = String(url || '');
      return originalOpen(method, url, ...rest);
    };
    xhr.addEventListener('load', () => {
      const responseUrl = xhr.responseURL || requestUrl;
      try {
        if (/\.m3u8(?:$|\?)/i.test(responseUrl)) {
          processAppleTvHlsManifest(String(xhr.responseText || ''), responseUrl);
        } else if (/\/api\/uts\//i.test(responseUrl)) {
          const data = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
          processAppleTvMetadata(data, responseUrl);
        }
      } catch (_) {}
    });
    return xhr;
  };
  win.XMLHttpRequest.prototype = OriginalXHR.prototype;
}

export function setupAppleTvInterception() {
  ensureAppleTvState();
  const showId = readAppleTvShowId();
  if (showId) appleTvPendingShowId = showId;
  const isShowPage = /\/show\//i.test(typeof location === 'undefined' ? '' : location.pathname);
  if (isShowPage) {
    const title = readAppleTvPageTitle();
    if (showId && title) updateAppleTvShow(title, showId);
  }
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  setupAppleTvFetchInterception(win);
  setupAppleTvXhrInterception(win);
  setupAppleTvSerializedDataObserver();
  document.addEventListener('DOMContentLoaded', () => {
    const currentShowId = readAppleTvShowId();
    if (currentShowId) appleTvPendingShowId = currentShowId;
    if (/\/show\//i.test(location.pathname)) {
      const currentTitle = readAppleTvPageTitle();
      if (currentShowId && currentTitle) updateAppleTvShow(currentTitle, currentShowId);
    }
    maybeStartAppleTvSeriesCapture();
  }, { once: true });
}
