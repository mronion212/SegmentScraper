/** Prime Video catalogue, playback-resource, and timestamp extraction. */

import { state } from '../../core/state.js';
import { splitCreditRange } from '../../normalization/segment-mapper.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';
import { recordProviderEpisode } from '../../core/tvdb.js';
import { logCapturedTimestamps } from '../timestamp-logger.js';

const PRIME_VIDEO_METADATA_URL_PATTERN = /getvodplaybackresources/i;
const PRIME_VIDEO_ID_PATTERN = /^(?:[A-Z0-9]{9,12}|amzn1\.dv\.gti\.[a-f0-9-]{20,})$/i;
const PRIME_VIDEO_CARD_SELECTOR = '[data-testid="episode-list-item"], li[id^="av-ep-episode-"]';
const PRIME_VIDEO_EPISODE_HEADING_PATTERN = /^\s*(\d+)\s*[.\-:]\s*(.*?)\s*$/;
const PRIME_VIDEO_POLL_INTERVAL_MS = 250;
const PRIME_VIDEO_MAX_POLL_ATTEMPTS = 40;
const PRIME_VIDEO_SELECTION_TTL_MS = 60000;
const PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS = 5000;
const PRIME_VIDEO_SEGMENT_BATCH_DELAY_MS = 500;
const PRIME_VIDEO_SUPPORTED_EVENT_TYPES = new Set([
  'SKIP_RECAP',
  'SKIP_INTRO',
  'END_CREDITS',
  'END_CREDIT',
  'NEXT_UP',
  'AFTER_CREDITS',
  'POST_CREDITS',
  'AFTER_CREDIT_SCENE',
  'POST_CREDIT_SCENE',
  'MID_CREDITS',
  'DURING_CREDITS',
  'MID_CREDIT',
  'DURING_CREDIT',
  'MID_CREDITS_SCENE',
  'DURING_CREDITS_SCENE',
  'MID_CREDIT_SCENE',
  'DURING_CREDIT_SCENE',
]);

const PRIME_VIDEO_EXTRA_SCENE_EVENT_TYPES = new Set([
  'AFTER_CREDITS',
  'POST_CREDITS',
  'AFTER_CREDIT_SCENE',
  'POST_CREDIT_SCENE',
  'MID_CREDITS',
  'DURING_CREDITS',
  'MID_CREDIT',
  'DURING_CREDIT',
  'MID_CREDITS_SCENE',
  'DURING_CREDITS_SCENE',
  'MID_CREDIT_SCENE',
  'DURING_CREDIT_SCENE',
]);

/** Keep Prime diagnostics in the regular Console log stream. */
function logPrimeVideo(message, details) {
  if (typeof console === 'undefined') return;
  const writeLog = typeof console.log === 'function'
    ? console.log.bind(console)
    : typeof console.info === 'function'
      ? console.info.bind(console)
      : null;
  if (!writeLog) return;
  if (details === undefined) writeLog(`[PVE] ${message}`);
  else writeLog(`[PVE] ${message}`, details);
}

function isPrimeVideoMetadataUrl(url) {
  return PRIME_VIDEO_METADATA_URL_PATTERN.test(String(url || ''));
}

function readPrimeVideoRequestBody(body) {
  if (typeof body === 'string') return body;
  if (!body) return '';
  try {
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData && typeof body.entries === 'function') {
      return [...body.entries()]
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
    }
  } catch (_) {}
  return '';
}

async function readPrimeVideoFetchRequestBody(input, init) {
  const initBody = readPrimeVideoRequestBody(init?.body);
  if (initBody) return initBody;
  try {
    if (input && typeof input === 'object' && typeof input.clone === 'function') {
      return await input.clone().text().catch(() => '');
    }
  } catch (_) {}
  return '';
}

function isPrimeVideoTitleId(value) {
  return typeof value === 'string' && PRIME_VIDEO_ID_PATTERN.test(value);
}

function ensurePrimeVideoState() {
  if (!(state.primeVideoTitleMap instanceof Map)) state.primeVideoTitleMap = new Map();
  if (!(state.primeVideoPendingByTitleId instanceof Map)) state.primeVideoPendingByTitleId = new Map();
  if (!(state.primeVideoDetailMap instanceof Map)) state.primeVideoDetailMap = new Map();
  if (!(state.primeVideoPlaybackTitleByDetailId instanceof Map)) state.primeVideoPlaybackTitleByDetailId = new Map();
  if (!(state.primeVideoCatalogByShowId instanceof Map)) state.primeVideoCatalogByShowId = new Map();
  if (!(state.primeVideoMetadataByTitleId instanceof Map)) state.primeVideoMetadataByTitleId = new Map();
  if (!(state.primeVideoEpisodeTitleByTitleId instanceof Map)) state.primeVideoEpisodeTitleByTitleId = new Map();
  if (!(state.primeVideoMovieEventsByTitleId instanceof Map)) state.primeVideoMovieEventsByTitleId = new Map();
  if (!(state.primeVideoMovieRuntimeByTitleId instanceof Map)) state.primeVideoMovieRuntimeByTitleId = new Map();
  if (!(state.primeVideoMovieDurationPolls instanceof Map)) state.primeVideoMovieDurationPolls = new Map();
  if (!(state.primeVideoFetchedSeasonCatalogUrls instanceof Set)) state.primeVideoFetchedSeasonCatalogUrls = new Set();
  if (!(state.primeVideoPollingTitleIds instanceof Set)) state.primeVideoPollingTitleIds = new Set();
  if (!(state.primeVideoPendingOutroTitleIds instanceof Set)) state.primeVideoPendingOutroTitleIds = new Set();
  if (!(state.primeVideoSegmentBatches instanceof Map)) state.primeVideoSegmentBatches = new Map();
}

function findPrimeVideoTitleIdInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const keys = ['asin', 'ASIN', 'titleId', 'titleID', 'contentId', 'catalogId'];
  for (const key of keys) {
    if (isPrimeVideoTitleId(obj[key])) return obj[key];
  }
  for (const key in obj) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      const found = findPrimeVideoTitleIdInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractPrimeVideoTitleId(bodyText, url) {
  if (url) {
    const titleIdMatch = url.match(/[?&](?:titleId|cGTI)=([^&]+)/i);
    if (titleIdMatch) {
      const titleId = decodeURIComponent(titleIdMatch[1]);
      if (isPrimeVideoTitleId(titleId)) return titleId;
    }
    const legacyIdMatch = url.match(/[?&](?:asin|ASIN)=([A-Z0-9]{9,12})/i);
    if (legacyIdMatch) return legacyIdMatch[1];
  }
  if (!bodyText) return null;
  const queryIdMatch = String(bodyText).match(/(?:^|[?&])(?:titleId|cGTI|asin|ASIN)=([^&#]+)/i);
  if (queryIdMatch) {
    const titleId = decodeURIComponent(queryIdMatch[1]);
    if (isPrimeVideoTitleId(titleId)) return titleId;
  }
  try {
    const found = findPrimeVideoTitleIdInObject(JSON.parse(bodyText));
    if (found) return found;
  } catch (_) {}

  const patterns = [
    /"(?:asin|titleId|titleID|contentId|catalogId)"\s*:\s*"((?:amzn1\.dv\.gti\.[a-f0-9-]{20,})|(?:[A-Z0-9]{9,12}))"/i,
    /(?:asin|titleId)=((?:amzn1\.dv\.gti\.[a-f0-9-]{20,})|(?:[A-Z0-9]{9,12}))/i,
  ];
  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function coercePrimeVideoInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function findPrimeVideoEpisodeMetadata(root) {
  const candidates = [];
  const visited = new WeakSet();
  const seasonKeys = ['seasonNumber', 'season', 'seasonSequenceNumber', 'seasonSequence'];
  const episodeKeys = ['episodeNumber', 'episode', 'episodeSequenceNumber', 'episodeSequence'];
  const firstInteger = (node, keys) => {
    for (const key of keys) {
      const value = coercePrimeVideoInteger(node?.[key]);
      if (value != null) return value;
    }
    return null;
  };

  function walk(node, depth = 0, path = '') {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      return;
    }

    const season = firstInteger(node, seasonKeys);
    const episode = firstInteger(node, episodeKeys);
    if (season != null && episode != null) {
      const seriesTitle = String(node.seriesTitle || node.showTitle || node.seriesName || node.parentTitle || '').trim();
      const episodeTitle = String(node.episodeTitle || node.title || node.name || '').trim();
      const catalogScore = /catalogMetadata|catalog/i.test(path) ? 4 : 0;
      candidates.push({ season, episode, seriesTitle, episodeTitle, score: catalogScore + (seriesTitle ? 2 : 0) + (episodeTitle ? 1 : 0) });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1, path ? `${path}.${key}` : key);
    }
  }

  walk(root);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function isPrimeVideoMovieType(value) {
  return ['MOVIE', 'FILM', 'FEATURE'].includes(String(value || '').trim().toUpperCase());
}

function isPrimeVideoMovieNode(node) {
  const typeValues = [
    node?.contentType,
    node?.type,
    node?.titleType,
    node?.subType,
    node?.subtype,
    node?.mediaType,
    node?.media_type,
    node?.entityType,
    node?.contentCategory,
    node?.catalogType,
    node?.videoType,
  ];
  return typeValues.some(isPrimeVideoMovieType) ||
    ['isMovie', 'isFilm', 'isFeature'].some(key => node?.[key] === true || node?.[key] === 1 || node?.[key] === 'true');
}

function findPrimeVideoMovieMetadata(root) {
  const candidates = [];
  const visited = new WeakSet();
  const episodeKeys = ['episodeNumber', 'episode', 'episodeSequenceNumber', 'episodeSequence'];

  function hasEpisodeNumber(node) {
    return episodeKeys.some(key => coercePrimeVideoInteger(node?.[key]) != null);
  }

  function walk(node, depth = 0, path = '') {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      return;
    }

    if (isPrimeVideoMovieNode(node) && !hasEpisodeNumber(node)) {
      const title = String(node.movieTitle || node.movieName || node.displayTitle || node.title || node.name || node.label || '').trim();
      const seriesTitle = String(node.seriesTitle || node.showTitle || node.parentTitle || '').trim();
      const year = node.releaseYear || node.year || node.releaseDate?.slice?.(0, 4) || '';
      const catalogScore = /catalogMetadata|catalog/i.test(path) ? 4 : 0;
      candidates.push({
        title: title || seriesTitle,
        year,
        score: catalogScore + (title ? 3 : 0) + (year ? 1 : 0),
      });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1, path ? `${path}.${key}` : key);
    }
  }

  walk(root);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function findPrimeVideoEpisodeTitle(root, expectedShowTitle = '') {
  const candidates = [];
  const visited = new WeakSet();
  const normalizedShowTitle = String(expectedShowTitle || '').trim().toLowerCase();

  function walk(node, depth = 0, path = '') {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      return;
    }

    const contentType = String(node.contentType || node.type || node.titleType || '').toUpperCase();
    const episodeContext = contentType === 'EPISODE' ||
      coercePrimeVideoInteger(node.episodeNumber || node.episodeSequenceNumber) != null;
    for (const key of ['episodeTitle', 'displayTitle', 'title', 'name']) {
      const title = typeof node[key] === 'string' ? node[key].trim() : '';
      if (!title || title.length > 300 || title.toLowerCase() === normalizedShowTitle) continue;
      let score = key === 'episodeTitle' ? 20 : 0;
      if (episodeContext) score += 12;
      if (/catalogMetadata\.catalog|episode/i.test(path)) score += 6;
      if (key === 'displayTitle') score += 2;
      candidates.push({ title, score });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1, path ? `${path}.${key}` : key);
    }
  }

  walk(root);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.title || '';
}

function normalizePrimeVideoEventType(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return {
    INTRO: 'SKIP_INTRO',
    RECAP: 'SKIP_RECAP',
    CREDITS: 'END_CREDITS',
    CREDIT: 'END_CREDIT',
  }[normalized] || normalized;
}

function getPrimeVideoEventType(event) {
  return normalizePrimeVideoEventType(
    event?.eventType || event?.elementType || event?.type || event?.name
  );
}

function getPrimeVideoTransitionRoots(data) {
  return [
    data?.transitionTimecodes?.result,
    data?.transitionTimecodes,
    data?.vodPlaybackUrls?.result?.transitionTimecodes?.result,
    data?.vodPlaybackUrls?.result?.transitionTimecodes,
    data?.vodPlaylistedPlaybackUrls?.result?.transitionTimecodes?.result,
    data?.vodPlaylistedPlaybackUrls?.result?.transitionTimecodes,
  ].filter(root => root && typeof root === 'object');
}

function readPrimeVideoTransitionBoundary(roots, keys) {
  for (const root of roots) {
    for (const key of keys) {
      const value = coercePrimeVideoMilliseconds(root?.[key]);
      if (value != null) return value;
    }
  }
  return null;
}

/**
 * Prime has returned two transition-timecode shapes over time: the current
 * result.events form and the older skipElements/endCreditsStart form. Keep
 * the rest of the extractor independent from that response detail.
 */
function readPrimeVideoTransitionEvents(data) {
  const roots = getPrimeVideoTransitionRoots(data);
  const rawEvents = [];
  const seenRawEvents = new Set();
  for (const root of roots) {
    for (const key of ['events', 'skipElements']) {
      if (!Array.isArray(root?.[key])) continue;
      for (const event of root[key]) {
        const rawKey = JSON.stringify(event);
        if (seenRawEvents.has(rawKey)) continue;
        seenRawEvents.add(rawKey);
        rawEvents.push(event);
      }
    }
  }

  const endCreditsStartMs = readPrimeVideoTransitionBoundary(roots, [
    'endCreditsStartMs',
    'endCreditsStart',
    'creditsStartMs',
    'creditsStart',
  ]);
  const endCreditsEndMs = readPrimeVideoTransitionBoundary(roots, [
    'endCreditsEndMs',
    'endCreditsEnd',
    'creditsEndMs',
    'creditsEnd',
  ]);
  const events = rawEvents.map(event => ({
    ...(event && typeof event === 'object' ? event : {}),
    eventType: getPrimeVideoEventType(event),
  }));

  const hasEndCreditsEvent = events.some(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)));
  if (!hasEndCreditsEvent && endCreditsStartMs != null) {
    events.push({
      eventType: 'END_CREDITS',
      startTimeMs: endCreditsStartMs,
      ...(endCreditsEndMs == null ? {} : { endTimeMs: endCreditsEndMs }),
    });
  } else if (endCreditsEndMs != null) {
    for (const event of events) {
      if (!['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event))) continue;
      if (readPrimeVideoEventTimeMs(event, 'end') == null) event.endTimeMs = endCreditsEndMs;
    }
  }
  return events;
}

function parsePrimeVideoEpisodeText(text) {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const patterns = [
    /\bS\s*(\d+)\s*(?:E|EP|AFL\.?|FOLGE)\s*(\d+)\b/i,
    /\b(?:SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*(\d+)[^\d]{0,30}(?:EPISODE|AFLEVERING|FOLGE|EPISODIO)\s*(\d+)\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const season = coercePrimeVideoInteger(match[1]);
    const episode = coercePrimeVideoInteger(match[2]);
    if (season == null || episode == null) continue;
    const episodeTitle = normalized
      .slice((match.index || 0) + match[0].length)
      .replace(/^\s*[-:|.]\s*/, '')
      .trim();
    return { season, episode, episodeTitle };
  }
  return null;
}

function readPrimeVideoPlayerSnapshot() {
  const player = document.getElementById('dv-web-player');
  const isPlayerActive = !!player && player.offsetWidth > 0 && player.offsetHeight > 0;
  let season = null;
  let episode = null;
  let episodeTitle = '';

  const candidates = [];
  if (player?.querySelectorAll) {
    candidates.push(...player.querySelectorAll(
      '[class*="episode-info" i], [data-testid*="episode" i], [data-automation-id*="episode" i], [aria-label*="episode" i], [aria-label*="aflevering" i]'
    ));
  }
  candidates.push(player);

  for (const node of [...new Set(candidates.filter(Boolean))]) {
    const ariaLabel = node.getAttribute?.('aria-label') || '';
    const text = `${ariaLabel} ${node.textContent || ''}`.trim();
    const parsed = parsePrimeVideoEpisodeText(text);
    if (!parsed) continue;
    season = parsed.season;
    episode = parsed.episode;
    const titleNode = node.querySelector?.('[class*="title" i], [data-testid*="title" i]');
    episodeTitle = String(titleNode?.textContent || parsed.episodeTitle || '').trim();
    break;
  }
  return { isPlayerActive, season, episode, title: document.title, episodeTitle };
}

function updatePrimeVideoTitle(rawTitle) {
  const cleaned = rawTitle.replace(/^Prime Video[:\-]\s*/i, '').trim();
  const seasonMatch = cleaned.match(/\s*(?:-|–)?\s*(?:S|SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*\d+\s*$/i);
  const title = seasonMatch ? cleaned.slice(0, seasonMatch.index).trim() : cleaned;
  handleDetectedShow({ title, showId: title });
  return title;
}

function readPrimeVideoSelectedSeason(root = document) {
  const selector = root.querySelector?.('#av-droplist-av-atf-season-selector');
  const label = selector?.getAttribute?.('aria-label') || selector?.value || '';
  const pageTitle = root.title || '';
  const number = String(label).match(/\d+/)?.[0] ||
    String(pageTitle).match(/(?:^|\s|-)(?:S|SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*(\d+)\b/i)?.[1];
  return coercePrimeVideoInteger(number);
}

function readPrimeVideoSeriesTitle(root = document) {
  const heading = root.querySelector?.('main h1') || root.querySelector?.('h1');
  const text = String(heading?.textContent || '').trim();
  if (text) return text;
  return String(heading?.querySelector?.('img[alt]')?.getAttribute?.('alt') || '').trim();
}

function readPrimeVideoCardTitleId(card) {
  const selector = card.querySelector?.('input[id^="selector-"]');
  const selectorId = selector?.getAttribute?.('id') || selector?.id || '';
  const titleId = selectorId.replace(/^selector-/, '');
  if (isPrimeVideoTitleId(titleId)) return titleId;

  const metadataNode = card.querySelector?.('[data-testid*="amzn1.dv.gti."], [data-automation-id*="amzn1.dv.gti."]');
  if (metadataNode) {
    for (const attribute of ['data-testid', 'data-automation-id']) {
      const value = metadataNode.getAttribute?.(attribute) || '';
      const match = value.match(/amzn1\.dv\.gti\.[a-f0-9-]{20,}/i);
      if (match && isPrimeVideoTitleId(match[0])) return match[0];
    }
  }

  const link = card.querySelector?.('a[href*="cGTI="], a[href*="titleId="]');
  return extractPrimeVideoTitleId('', link?.getAttribute?.('href') || '');
}

function readPrimeVideoCardEpisode(card) {
  const heading = String(card?.querySelector?.('h3')?.textContent || '').trim();
  const match = heading.match(PRIME_VIDEO_EPISODE_HEADING_PATTERN);
  const episode = coercePrimeVideoInteger(match?.[1]);
  return episode == null ? null : { episode, episodeTitle: match?.[2] || '' };
}

function readPrimeVideoDetailId(url) {
  return String(url || '').match(/\/detail\/([A-Z0-9]{10,})/i)?.[1]?.toUpperCase() || null;
}

function readPrimeVideoCardDetailId(card) {
  const directLink = card.querySelector?.('a[href*="/detail/"]');
  const directId = readPrimeVideoDetailId(directLink?.getAttribute?.('href'));
  if (directId) return directId;

  const returnLink = card.querySelector?.('a[href*="return_url="]');
  const href = returnLink?.getAttribute?.('href') || '';
  const encoded = href.match(/[?&]return_url=([^&]+)/i)?.[1];
  if (!encoded || typeof atob !== 'function') return null;
  try {
    const base64 = decodeURIComponent(encoded).replace(/-/g, '+').replace(/_/g, '/');
    return readPrimeVideoDetailId(atob(base64));
  } catch (_) {
    return null;
  }
}

function readCurrentPrimeVideoDetailId() {
  if (typeof location === 'undefined') return null;
  return readPrimeVideoDetailId(location.href || location.pathname);
}

function refreshPrimeVideoEpisodeTitle(showId, season, episode, episodeTitle) {
  if (!episodeTitle) return;
  for (const snapshot of state.primeVideoTitleMap.values()) {
    if (snapshot.showId === showId && snapshot.season === season && snapshot.episode === episode) {
      snapshot.episodeTitle = episodeTitle;
    }
  }
  for (const item of state.allItems) {
    if (item._showId === showId && item.season === season && item.episode === episode) {
      item._episodeTitle = episodeTitle;
    }
  }
  for (const batch of state.primeVideoSegmentBatches.values()) {
    if (batch.showId !== showId || batch.season !== season || batch.episode !== episode) continue;
    batch.episodeTitle = episodeTitle;
    batch.items.forEach(item => { item._episodeTitle = episodeTitle; });
  }
  if (state.primeVideoActiveEpisode?.showId === showId &&
      state.primeVideoActiveEpisode.season === season && state.primeVideoActiveEpisode.episode === episode) {
    state.primeVideoActiveEpisode.episodeTitle = episodeTitle;
  }
}

function settlePrimeVideoPlaybackFallbacks(titleId) {
  const currentDetailId = readCurrentPrimeVideoDetailId();
  if (currentDetailId && state.primeVideoDetailMap.has(currentDetailId) &&
      !state.primeVideoPlaybackTitleByDetailId.has(currentDetailId)) {
    state.primeVideoPlaybackTitleByDetailId.set(currentDetailId, titleId);
  }

  if (state.primeVideoSelectedEpisode && state.primeVideoSelectedEpisode.resolvedTitleId == null) {
    state.primeVideoSelectedEpisode.resolvedTitleId = titleId;
  }
}

function setPrimeVideoActiveEpisode(snapshot) {
  const current = state.primeVideoActiveEpisode;
  if (current?.showId === snapshot.showId) {
    const currentPosition = current.season * 100000 + current.episode;
    const nextPosition = snapshot.season * 100000 + snapshot.episode;
    if (nextPosition < currentPosition) return;
  }
  state.primeVideoActiveEpisode = {
    season: snapshot.season,
    episode: snapshot.episode,
    episodeTitle: snapshot.episodeTitle || '',
    showId: snapshot.showId,
  };
}

function hasPrimeVideoSegmentEvents(data) {
  return readPrimeVideoTransitionEvents(data).some(event =>
    PRIME_VIDEO_SUPPORTED_EVENT_TYPES.has(getPrimeVideoEventType(event))
  );
}

function inferNextPrimeVideoEpisode() {
  const active = state.primeVideoActiveEpisode;
  if (!active?.showId || active.season == null || active.episode == null) return null;
  const rawPageTitle = readPrimeVideoSeriesTitle(document) || String(document.title || '')
    .replace(/^Prime Video[:\-]\s*/i, '')
    .replace(/\s*(?:-|\u2013)?\s*(?:S|SEASON|SEIZOEN|SAISON|STAFFEL|TEMPORADA|STAGIONE)\s*\d+\s*$/i, '')
    .trim();
  if (rawPageTitle && rawPageTitle !== active.showId) return null;

  const seasons = state.primeVideoCatalogByShowId.get(active.showId);
  const currentSeason = seasons?.get(active.season);
  const lastCatalogEpisode = currentSeason?.size ? Math.max(...currentSeason.keys()) : null;
  let season = active.season;
  let episode = active.episode + 1;
  if (lastCatalogEpisode != null && active.episode >= lastCatalogEpisode) {
    season++;
    episode = 1;
  }

  const catalogSnapshot = seasons?.get(season)?.get(episode);
  return {
    season,
    episode,
    episodeTitle: catalogSnapshot?.episodeTitle || '',
    showId: active.showId,
    seriesTitle: active.showId,
  };
}

export function rememberPrimeVideoEpisodeSelection(card, root = document) {
  ensurePrimeVideoState();
  const season = readPrimeVideoSelectedSeason(root);
  const seriesTitle = readPrimeVideoSeriesTitle(root);
  const cardEpisode = readPrimeVideoCardEpisode(card);
  if (season == null || !cardEpisode || !seriesTitle) return false;

  const showId = updatePrimeVideoTitle(seriesTitle);
  state.primeVideoSelectedEpisode = {
    season,
    ...cardEpisode,
    showId,
    seriesTitle,
    selectedAt: Date.now(),
  };
  return true;
}

/**
 * Prime's current detail page exposes stable episode GTIs before playback.
 * Cache them up front because the player overlay no longer reliably renders
 * the old atvwebplayersdk episode-info element.
 */
export function scanPrimeVideoEpisodeCatalog(root = document) {
  ensurePrimeVideoState();
  const season = readPrimeVideoSelectedSeason(root);
  const seriesTitle = readPrimeVideoSeriesTitle(root);
  if (season == null || !seriesTitle) return 0;

  const showId = updatePrimeVideoTitle(seriesTitle);
  const cards = root.querySelectorAll?.(PRIME_VIDEO_CARD_SELECTOR) || [];
  let seasons = state.primeVideoCatalogByShowId.get(showId);
  if (!seasons) {
    seasons = new Map();
    state.primeVideoCatalogByShowId.set(showId, seasons);
  }
  let seasonCatalog = seasons.get(season);
  if (!seasonCatalog) {
    seasonCatalog = new Map();
    seasons.set(season, seasonCatalog);
  }
  const seen = new Set();
  let found = 0;

  for (const card of cards) {
    const cardEpisode = readPrimeVideoCardEpisode(card);
    const titleId = readPrimeVideoCardTitleId(card);
    if (!cardEpisode || !titleId || seen.has(titleId)) continue;
    seen.add(titleId);

    const snapshot = { season, ...cardEpisode, showId };
    const previous = state.primeVideoTitleMap.get(titleId);
    const unchanged = previous?.showId === showId &&
      previous.season === season &&
      previous.episode === cardEpisode.episode &&
      previous.episodeTitle === cardEpisode.episodeTitle;
    if (!unchanged) {
      const collision = findPrimeVideoEpisodeCollision(titleId, showId, season, cardEpisode.episode);
      state.primeVideoTitleMap.set(titleId, snapshot);
      seasonCatalog.set(cardEpisode.episode, snapshot);
      refreshPrimeVideoEpisodeTitle(showId, season, cardEpisode.episode, cardEpisode.episodeTitle);
      if (!collision) {
        recordProviderEpisode({ providerId: titleId, season, episode: cardEpisode.episode, title: cardEpisode.episodeTitle }, showId);
      }
    } else if (!seasonCatalog.has(cardEpisode.episode)) {
      seasonCatalog.set(cardEpisode.episode, previous);
    }
    const detailId = readPrimeVideoCardDetailId(card);
    if (detailId) {
      const previousDetail = state.primeVideoDetailMap.get(detailId);
      const detailSnapshot = { ...(unchanged ? previous : snapshot), seriesTitle };
      if (!previousDetail ||
          previousDetail.showId !== detailSnapshot.showId ||
          previousDetail.season !== detailSnapshot.season ||
          previousDetail.episode !== detailSnapshot.episode ||
          previousDetail.episodeTitle !== detailSnapshot.episodeTitle ||
          previousDetail.seriesTitle !== detailSnapshot.seriesTitle) {
        state.primeVideoDetailMap.set(detailId, detailSnapshot);
      }
    }
    found++;
  }
  return found;
}

export async function preloadPrimeVideoSeasonCatalogs(root = document, options = {}) {
  ensurePrimeVideoState();
  const baseUrl = root.location?.href || (typeof location !== 'undefined' ? location.href : '');
  if (!baseUrl) return 0;
  const currentDetailId = readPrimeVideoDetailId(baseUrl);
  const links = root.querySelectorAll?.('a[href*="atv_dp_season_select_s"]') || [];
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const parseHtml = options.parseHtml || (html => new DOMParser().parseFromString(html, 'text/html'));
  let total = 0;

  await Promise.all([...links].map(async link => {
    const href = link.getAttribute?.('href') || '';
    if (!href) return;
    let url;
    try {
      url = new URL(href, baseUrl);
      if (url.origin !== new URL(baseUrl).origin) return;
    } catch (_) {
      return;
    }

    const urlKey = url.href;
    if (state.primeVideoFetchedSeasonCatalogUrls.has(urlKey)) return;
    state.primeVideoFetchedSeasonCatalogUrls.add(urlKey);
    if (readPrimeVideoDetailId(urlKey) === currentDetailId) return;

    try {
      const response = await fetchImpl(urlKey, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
      const seasonDocument = parseHtml(await response.text());
      const found = scanPrimeVideoEpisodeCatalog(seasonDocument);
      total += found;
      if (found) {
        logPrimeVideo('Preloaded Prime Video season catalogue:', {
          url: urlKey,
          episodes: found,
        });
      }
    } catch (error) {
      state.primeVideoFetchedSeasonCatalogUrls.delete(urlKey);
      console.warn('[PVE] Could not preload season catalogue:', urlKey, error);
    }
  }));
  return total;
}

function findPrimeVideoEpisodeCollision(titleId, showId, season, episode) {
  for (const [knownTitleId, known] of state.primeVideoTitleMap) {
    if (knownTitleId !== titleId && known.showId === showId && known.season === season && known.episode === episode) return known;
  }
  return null;
}

function coercePrimeVideoMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function coercePrimeVideoClockMilliseconds(value) {
  const numeric = coercePrimeVideoMilliseconds(value);
  if (numeric != null) return numeric;
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return null;
  const seconds = parts.length === 2
    ? parts[0] * 60 + parts[1]
    : parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : null;
  return seconds == null || seconds < 0 ? null : seconds * 1000;
}

function readPrimeVideoEventTimeMs(event, boundary) {
  const keys = boundary === 'start'
    ? ['startTimeMs', 'startTimecodeMs', 'startTimeCodeMs', 'startMs']
    : ['endTimeMs', 'endTimecodeMs', 'endTimeCodeMs', 'endMs'];
  const nestedSources = [
    event,
    event?.timecode,
    event?.timeCode,
    event?.timecodes,
    event?.range,
  ];
  for (const source of nestedSources) {
    for (const key of keys) {
      const value = coercePrimeVideoClockMilliseconds(source?.[key]);
      if (value != null) return value;
    }
  }
  const secondKeys = boundary === 'start'
    ? ['startTime', 'start', 'startSec', 'startSeconds', 'offset']
    : ['endTime', 'end', 'endSec', 'endSeconds'];
  for (const source of nestedSources) {
    for (const key of secondKeys) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value) && value >= 0) return value * 1000;
      const clockMilliseconds = coercePrimeVideoClockMilliseconds(source?.[key]);
      if (clockMilliseconds != null) return clockMilliseconds;
    }
  }
  return null;
}

function findPrimeVideoRuntimeMs(root, events = []) {
  const candidates = events
    .map(event => readPrimeVideoEventTimeMs(event, 'end'))
    .filter(value => value != null);
  const visited = new WeakSet();
  const millisecondKeys = new Set([
    'runtimems', 'runtimemillis', 'runtimemilliseconds',
    'durationms', 'durationmillis', 'durationmilliseconds',
    'contentdurationms', 'contentdurationmillis', 'contentdurationmilliseconds',
  ]);
  const secondKeys = new Set([
    'runtimeseconds', 'runtimeinseconds',
    'durationseconds', 'durationinseconds',
    'runtime', 'duration', 'contentduration',
  ]);

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        if (millisecondKeys.has(normalizedKey)) candidates.push(number);
        if (secondKeys.has(normalizedKey)) candidates.push(
          ['runtime', 'duration', 'contentduration'].includes(normalizedKey) && number > 100000
            ? number
            : number * 1000
        );
      } else if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  }

  walk(root);
  return candidates.length ? Math.max(...candidates) : null;
}

function parsePrimeVideoClockSeconds(value) {
  const parts = String(value || '').split(':').map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function readPrimeVideoMediaDurationMs() {
  const candidates = [];
  const videos = document.querySelectorAll?.('#dv-web-player video, [id^="dv-web-player"] video, video') || [];
  for (const video of videos) {
    const durationSeconds = Number(video?.duration);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) candidates.push(durationSeconds);
    try {
      const seekableEnd = video.seekable?.length ? Number(video.seekable.end(video.seekable.length - 1)) : null;
      if (Number.isFinite(seekableEnd) && seekableEnd > 0) candidates.push(seekableEnd);
    } catch (_) {}
  }

  const timeIndicators = document.querySelectorAll?.(
    '#dv-web-player .atvwebplayersdk-timeindicator-text, [id^="dv-web-player"] .atvwebplayersdk-timeindicator-text'
  ) || [];
  for (const indicator of timeIndicators) {
    const text = `${indicator.getAttribute?.('aria-label') || ''} ${indicator.textContent || ''}`;
    const clocks = text.match(/(?:\d{1,2}:)?\d{1,2}:\d{2}/g) || [];
    if (clocks.length < 2) continue;
    const elapsedSeconds = parsePrimeVideoClockSeconds(clocks[0]);
    const remainingSeconds = parsePrimeVideoClockSeconds(clocks[1]);
    if (elapsedSeconds != null && remainingSeconds != null) candidates.push(elapsedSeconds + remainingSeconds);
  }

  return candidates.length ? Math.max(...candidates) * 1000 : null;
}

function logPrimeVideoTimestamps(titleId, showId, season, episode, episodeTitle, items, mediaType = 'tv') {
  logCapturedTimestamps({
    prefix: 'PVE',
    showTitle: showId,
    mediaType,
    season,
    episode,
    episodeTitle,
    providerIdLabel: 'titleId',
    providerId: titleId,
    items,
  });
}

function flushPrimeVideoSegmentBatch(titleId) {
  const batch = state.primeVideoSegmentBatches.get(titleId);
  if (!batch) return;
  state.primeVideoSegmentBatches.delete(titleId);
  const items = batch.items.filter(item => !state.allItems.some(existing => existing._eid === item._eid && existing.start_sec === item.start_sec && existing.end_sec === item.end_sec));
  logPrimeVideo('Flushing Prime Video segment batch:', {
    titleId,
    showId: batch.showId,
    season: batch.season,
    episode: batch.episode,
    received: batch.items.length,
    newItems: items.length,
    skippedExisting: batch.items.length - items.length,
  });
  logPrimeVideoTimestamps(titleId, batch.showId, batch.season, batch.episode, batch.episodeTitle, items);
  recordExtractedSegments(items);
}

function queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, items, { waitForOutro = false, outroResolved = false } = {}) {
  let batch = state.primeVideoSegmentBatches.get(titleId);
  if (!batch) {
    batch = { titleId, showId, season, episode, episodeTitle, items: [], timer: null, waitingForOutro: false };
    state.primeVideoSegmentBatches.set(titleId, batch);
  }
  for (const item of items) {
    if (!batch.items.some(existing => existing._eid === item._eid && existing.start_sec === item.start_sec && existing.end_sec === item.end_sec)) batch.items.push(item);
  }
  if (waitForOutro) batch.waitingForOutro = true;
  if (outroResolved) batch.waitingForOutro = false;
  if (batch.waitingForOutro || !batch.items.length) return;

  if (batch.timer != null && typeof clearTimeout === 'function') clearTimeout(batch.timer);
  if (typeof window === 'undefined') {
    flushPrimeVideoSegmentBatch(titleId);
    return;
  }
  batch.timer = setTimeout(() => flushPrimeVideoSegmentBatch(titleId), PRIME_VIDEO_SEGMENT_BATCH_DELAY_MS);
}

function appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, segmentType, startTimeMs, endTimeMs, mediaType = 'tv', creditPart = null) {
  const isMovie = String(mediaType).toLowerCase() === 'movie';
  const partSuffix = creditPart ? `_${creditPart}` : '';
  const episodeId = isMovie ? `${titleId}_movie_${segmentType}${partSuffix}` : `${titleId}_${segmentType}${partSuffix}`;
  const alreadyCaptured = item => item.start_sec === startTimeMs / 1000 && item.end_sec === endTimeMs / 1000 && (item._eid === episodeId || (
    item._showId === showId &&
    String(item.media_type || 'tv').toLowerCase() === String(mediaType).toLowerCase() &&
    item.season === season &&
    item.episode === episode &&
    item.segment_type === segmentType &&
    (item.credit_part || null) === (creditPart || null)
  ));
  if ((!isMovie && state.allItems.some(alreadyCaptured)) || extractedItems.some(alreadyCaptured)) return false;
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: episodeTitle,
    _showId: showId,
    ...(isMovie ? { media_type: 'movie' } : {}),
    ...(creditPart ? { credit_part: creditPart } : {}),
    imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
    segment_type: segmentType,
    season,
    episode,
    start_sec: startTimeMs / 1000,
    end_sec: endTimeMs / 1000,
    _timing: { provider: 'prime-video', source: 'playback-event', unit: 'milliseconds', raw_start: startTimeMs, raw_end: endTimeMs },
  });
  return true;
}

function readPrimeVideoMoviePageTitle(titleId) {
  const heading = readPrimeVideoSeriesTitle(document);
  if (heading) return heading;
  const pageTitle = String(document.title || '')
    .replace(/^Prime Video[:\-]\s*/i, '')
    .trim();
  return pageTitle || titleId;
}

function clearPrimeVideoMovieDurationPoll(titleId) {
  const poll = state.primeVideoMovieDurationPolls.get(titleId);
  if (poll?.timer != null && typeof clearTimeout === 'function') clearTimeout(poll.timer);
  state.primeVideoMovieDurationPolls.delete(titleId);
}

function schedulePrimeVideoMovieDurationPoll(titleId, movieTitle) {
  if (typeof window === 'undefined' || typeof setTimeout !== 'function') return false;
  const existing = state.primeVideoMovieDurationPolls.get(titleId);
  if (existing?.timer != null) return true;
  if ((existing?.attempt || 0) >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) return false;

  const poll = existing || { attempt: 0, timer: null, movieTitle };
  poll.movieTitle = movieTitle || poll.movieTitle || titleId;
  poll.timer = setTimeout(() => {
    const current = state.primeVideoMovieDurationPolls.get(titleId);
    if (!current) return;
    current.timer = null;
    current.attempt++;
    state.primeVideoMovieDurationPolls.set(titleId, current);
    const events = state.primeVideoMovieEventsByTitleId.get(titleId) || [];
    if (!events.length) return;
    finalizePrimeVideoMovieEvents(
      titleId,
      current.movieTitle || titleId,
      { transitionTimecodes: { result: { events } } },
      state.primeVideoMovieRuntimeByTitleId.get(titleId) ?? null
    );
  }, PRIME_VIDEO_POLL_INTERVAL_MS);
  state.primeVideoMovieDurationPolls.set(titleId, poll);
  return true;
}

function hasPrimeVideoEpisodePageContext(titleId) {
  if (state.primeVideoTitleMap.has(titleId)) return true;
  if (state.primeVideoSelectedEpisode?.resolvedTitleId === titleId) return true;
  if (readPrimeVideoSelectedSeason(document) != null) return true;
  const cards = document.querySelectorAll?.(PRIME_VIDEO_CARD_SELECTOR) || [];
  return cards.length > 0;
}

function isLikelyPrimeVideoMoviePlayback(titleId, data) {
  if (state.mediaType === 'movie' && String(state.showId || '') === String(titleId)) return true;
  if (findPrimeVideoEpisodeMetadata(data) || hasPrimeVideoEpisodePageContext(titleId)) return false;
  const events = readPrimeVideoTransitionEvents(data);
  const hasCreditsEvent = events.some(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)));
  const hasCompleteCredits = events.some(event => {
    if (!['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event))) return false;
    const startTimeMs = readPrimeVideoEventTimeMs(event, 'start');
    const endTimeMs = readPrimeVideoEventTimeMs(event, 'end');
    return startTimeMs != null && endTimeMs != null && endTimeMs > startTimeMs;
  });
  const hasTvOnlyMarker = events.some(event => ['SKIP_RECAP', 'SKIP_INTRO'].includes(String(event?.eventType || '').toUpperCase()));
  return (hasCompleteCredits || hasCreditsEvent) && !hasTvOnlyMarker;
}

function finalizePrimeVideoMovieResponses(titleId, movieTitle, currentData = null) {
  const pending = state.primeVideoPendingByTitleId.get(titleId) || [];
  state.primeVideoPendingByTitleId.delete(titleId);
  state.primeVideoPollingTitleIds.delete(titleId);

  const payloads = [...pending, currentData].filter(data => hasPrimeVideoSegmentEvents(data));
  if (!payloads.length) return;
  const previousEvents = state.primeVideoMovieEventsByTitleId.get(titleId) || [];
  const incomingEvents = payloads.flatMap(data => readPrimeVideoTransitionEvents(data));
  const events = [];
  const seenEvents = new Set();
  for (const event of [...previousEvents, ...incomingEvents]) {
    const key = JSON.stringify(event);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    events.push(event);
  }
  state.primeVideoMovieEventsByTitleId.set(titleId, events);
  const runtimeCandidates = payloads
    .map(data => findPrimeVideoRuntimeMs(data, []))
    .filter(value => value != null);
  if (runtimeCandidates.length) {
    state.primeVideoMovieRuntimeByTitleId.set(titleId, Math.max(...runtimeCandidates));
  }
  finalizePrimeVideoMovieEvents(titleId, movieTitle, {
    transitionTimecodes: { result: { events } },
  }, state.primeVideoMovieRuntimeByTitleId.get(titleId) ?? null);
}

function finalizePrimeVideoMovieEvents(titleId, movieTitle, data, runtimeMsOverride = null) {
  const events = readPrimeVideoTransitionEvents(data);
  const extractedItems = [];
  const runtimeMs = runtimeMsOverride ?? findPrimeVideoRuntimeMs(data, []) ?? readPrimeVideoMediaDurationMs();
  const creditRanges = events
    .filter(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)))
    .map(event => ({
      startTimeMs: readPrimeVideoEventTimeMs(event, 'start'),
      endTimeMs: readPrimeVideoEventTimeMs(event, 'end') ?? runtimeMs,
    }))
    .filter(range => range.startTimeMs != null && range.endTimeMs != null && range.endTimeMs > range.startTimeMs);
  const creditRange = creditRanges.length ? {
    startTimeMs: Math.min(...creditRanges.map(range => range.startTimeMs)),
    endTimeMs: Math.max(...creditRanges.map(range => range.endTimeMs)),
  } : null;

  if (!creditRange) {
    const creditEvents = events
      .filter(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)))
      .map(event => ({
        type: getPrimeVideoEventType(event),
        startTimeMs: readPrimeVideoEventTimeMs(event, 'start'),
        endTimeMs: readPrimeVideoEventTimeMs(event, 'end'),
      }));
    const creditStartAvailable = creditEvents.some(event => event.startTimeMs != null);
    if (creditStartAvailable && schedulePrimeVideoMovieDurationPoll(titleId, movieTitle)) {
      const poll = state.primeVideoMovieDurationPolls.get(titleId);
      if (poll?.attempt === 0) {
        console.info('[PVE] Movie credits found; waiting for Prime media duration before finalizing:', {
          titleId,
          creditEvents,
        });
      }
      return;
    }
    console.warn('[PVE] Movie credits did not include a safe END_CREDITS range; NEXT_UP was ignored:', titleId, {
      creditEvents,
      eventTypes: events.map(getPrimeVideoEventType),
      runtimeMs,
    });
    return;
  }
  clearPrimeVideoMovieDurationPoll(titleId);

  const extraSceneEvents = events.filter(event => PRIME_VIDEO_EXTRA_SCENE_EVENT_TYPES.has(getPrimeVideoEventType(event)));
  const extraSceneEvent = extraSceneEvents
    .map(event => ({
      event,
      startTimeMs: readPrimeVideoEventTimeMs(event, 'start'),
      endTimeMs: readPrimeVideoEventTimeMs(event, 'end'),
    }))
    .filter(range => range.startTimeMs != null)
    .sort((a, b) => a.startTimeMs - b.startTimeMs)[0];
  const ranges = splitCreditRange({
    startSec: creditRange.startTimeMs / 1000,
    endSec: creditRange.endTimeMs / 1000,
    runtimeSec: runtimeMs == null ? null : runtimeMs / 1000,
    afterCreditsDetected: extraSceneEvents.length > 0,
    afterCreditsStartSec: extraSceneEvent?.startTimeMs == null ? null : extraSceneEvent.startTimeMs / 1000,
    afterCreditsEndSec: extraSceneEvent?.endTimeMs == null ? null : extraSceneEvent.endTimeMs / 1000,
  });
  for (const range of ranges) {
    appendPrimeVideoSegment(
      extractedItems,
      titleId,
      titleId,
      null,
      null,
      movieTitle,
      range.segmentType || 'outro',
      range.startSec * 1000,
      range.endSec * 1000,
      'movie',
      range.creditPart
    );
  }
  if (!ranges.length) console.warn('[PVE] Movie credits conflict with scene markers; withholding timestamps.', { titleId, creditRange, extraSceneEvent });

  const existingMovieItems = state.allItems.filter(item =>
    String(item?._showId || '') === String(titleId) &&
    String(item?.media_type || '').toLowerCase() === 'movie' &&
    ['outro', 'post-credits'].includes(item.segment_type)
  );
  const sameAsExisting = existingMovieItems.length === extractedItems.length && extractedItems.every(item =>
    existingMovieItems.some(existing =>
      existing._eid === item._eid &&
      Math.abs(Number(existing.start_sec) - Number(item.start_sec)) < 0.01 &&
      Math.abs(Number(existing.end_sec) - Number(item.end_sec)) < 0.01
    )
  );
  if (sameAsExisting) return;
  if (existingMovieItems.length) {
    state.allItems = state.allItems.filter(item => !existingMovieItems.includes(item));
  }
  logPrimeVideoTimestamps(titleId, movieTitle, null, null, movieTitle, extractedItems, 'movie');
  recordExtractedSegments(extractedItems);
}

function pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs, attempt = 0) {
  const endTimeMs = readPrimeVideoMediaDurationMs();
  if (endTimeMs != null && endTimeMs > startTimeMs) {
    const extractedItems = [];
    appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, 'outro', startTimeMs, endTimeMs);
    state.primeVideoPendingOutroTitleIds.delete(titleId);
    queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, extractedItems, { outroResolved: true });
    return;
  }
  if (attempt >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) {
    state.primeVideoPendingOutroTitleIds.delete(titleId);
    console.warn('[PVE] NEXT_UP had a start time, but no episode duration could be resolved:', titleId);
    queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, [], { outroResolved: true });
    return;
  }
  setTimeout(
    () => pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs, attempt + 1),
    PRIME_VIDEO_POLL_INTERVAL_MS
  );
}

function finalizePrimeVideoEvents(titleId, season, episode, data, episodeTitle = '', showId = state.showId) {
  const events = readPrimeVideoTransitionEvents(data);
  const extractedItems = [];
  const runtimeMs = findPrimeVideoRuntimeMs(data, events) ?? readPrimeVideoMediaDurationMs();
  const resolveEventRange = (event, useRuntime = false) => {
    const startTimeMs = readPrimeVideoEventTimeMs(event, 'start');
    let endTimeMs = readPrimeVideoEventTimeMs(event, 'end');
    if (useRuntime && (endTimeMs == null || endTimeMs <= startTimeMs)) endTimeMs = runtimeMs;
    return startTimeMs != null && endTimeMs != null && endTimeMs > startTimeMs
      ? { event, startTimeMs, endTimeMs }
      : null;
  };
  const outroCandidates = events.filter(event => {
    const eventType = getPrimeVideoEventType(event);
    return eventType === 'END_CREDITS' || eventType === 'END_CREDIT' || eventType === 'NEXT_UP';
  });
  const outroRange = outroCandidates
    .filter(event => ['END_CREDITS', 'END_CREDIT'].includes(getPrimeVideoEventType(event)))
    .map(event => resolveEventRange(event, true))
    .find(Boolean) || outroCandidates
    .filter(event => getPrimeVideoEventType(event) === 'NEXT_UP')
    .map(event => resolveEventRange(event, true))
    .find(Boolean);

  for (const event of events) {
    let segmentType = null;
    const eventType = getPrimeVideoEventType(event);
    if (eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (eventType === 'SKIP_INTRO') segmentType = 'intro';
    const range = event === outroRange?.event ? outroRange : resolveEventRange(event);
    if (event === outroRange?.event) segmentType = 'outro';
    if (!segmentType || !range) continue;
    appendPrimeVideoSegment(
      extractedItems,
      titleId,
      showId,
      season,
      episode,
      episodeTitle,
      segmentType,
      range.startTimeMs,
      range.endTimeMs
    );
  }

  if (!outroRange && outroCandidates.length) {
    const startTimeMs = outroCandidates
      .map(event => readPrimeVideoEventTimeMs(event, 'start'))
      .find(value => value != null);
    if (startTimeMs != null && !state.primeVideoPendingOutroTitleIds.has(titleId)) {
      state.primeVideoPendingOutroTitleIds.add(titleId);
      queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, extractedItems, { waitForOutro: true });
      pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs);
      return;
    } else if (startTimeMs == null) {
      console.warn('[PVE] Prime returned an outro event without a usable start time:', outroCandidates);
    }
  }
  logPrimeVideo(extractedItems.length
    ? 'Prepared Prime Video segment ranges:'
    : 'No usable Prime Video segment ranges in playback metadata:', {
    titleId,
    showId,
    season,
    episode,
    eventTypes: events.map(getPrimeVideoEventType),
    segments: extractedItems.map(item => ({ type: item.segment_type, start: item.start_sec, end: item.end_sec })),
  });
  queuePrimeVideoSegments(titleId, showId, season, episode, episodeTitle, extractedItems);
}

function commitPrimeVideoEpisode(titleId, snapshot, { allowNumberReuse = false } = {}) {
  const showId = updatePrimeVideoTitle(snapshot.seriesTitle || snapshot.title);
  const collision = findPrimeVideoEpisodeCollision(titleId, showId, snapshot.season, snapshot.episode);
  if (collision && !allowNumberReuse) return false;

  const episodeTitle = snapshot.episodeTitle || '';
  const resolvedSnapshot = { season: snapshot.season, episode: snapshot.episode, episodeTitle, showId };
  state.primeVideoTitleMap.set(titleId, resolvedSnapshot);
  setPrimeVideoActiveEpisode(resolvedSnapshot);
  settlePrimeVideoPlaybackFallbacks(titleId);
  state.primeVideoPollingTitleIds.delete(titleId);
  if (!collision) {
    recordProviderEpisode({ providerId: titleId, season: snapshot.season, episode: snapshot.episode, title: episodeTitle }, showId);
  }
  const pending = state.primeVideoPendingByTitleId.get(titleId) || [];
  state.primeVideoPendingByTitleId.delete(titleId);
  pending.forEach(data => finalizePrimeVideoEvents(titleId, snapshot.season, snapshot.episode, data, episodeTitle, showId));
  return true;
}

function pollPrimeVideoEpisode(titleId, attempt) {
  if ((state.mediaType === 'movie' && String(state.showId || '') === String(titleId)) ||
      state.primeVideoMovieEventsByTitleId.has(titleId)) {
    finalizePrimeVideoMovieResponses(titleId, state.showTitle || titleId);
    return;
  }
  const snapshot = readPrimeVideoPlayerSnapshot();
  if (snapshot.isPlayerActive && snapshot.season != null && snapshot.episode != null) {
    if (commitPrimeVideoEpisode(titleId, snapshot)) return;
  }
  if (attempt >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) {
    console.warn('[PVE] Could not resolve season/episode for title ID:', titleId);
    state.primeVideoPendingByTitleId.delete(titleId);
    state.primeVideoPollingTitleIds.delete(titleId);
    return;
  }
  setTimeout(() => pollPrimeVideoEpisode(titleId, attempt + 1), PRIME_VIDEO_POLL_INTERVAL_MS);
}

export function processPrimeVideoMetadata(data, bodyText, url) {
  ensurePrimeVideoState();
  const titleId = extractPrimeVideoTitleId(bodyText, url);
  const eventTypes = (data?.transitionTimecodes?.result?.events || []).map(getPrimeVideoEventType);
  if (!titleId) {
    logPrimeVideo('Skipped playback metadata without a recognizable title ID:', { url: String(url || ''), bodyLength: String(bodyText || '').length, eventTypes });
    return;
  }
  logPrimeVideo('Received Prime Video playback metadata:', { titleId, eventTypes });
  const movieMetadata = findPrimeVideoMovieMetadata(data);
  if (movieMetadata) {
    const movieTitle = movieMetadata.title || titleId;
    console.info('[PVE] Movie metadata classified; skipping season/episode resolution.', {
      titleId,
      title: movieTitle,
      year: movieMetadata.year || '',
    });
    handleDetectedShow({
      title: movieTitle,
      showId: titleId,
      year: movieMetadata.year || '',
      mediaType: 'movie',
    });
    finalizePrimeVideoMovieResponses(titleId, movieTitle, data);
    return;
  }
  if (state.mediaType === 'movie' && String(state.showId || '') === String(titleId)) {
    finalizePrimeVideoMovieResponses(titleId, state.showTitle || titleId, data);
    return;
  }
  if (isLikelyPrimeVideoMoviePlayback(titleId, data)) {
    const movieTitle = readPrimeVideoMoviePageTitle(titleId);
    console.info('[PVE] Movie playback classified from credit events; skipping season/episode resolution.', {
      titleId,
      title: movieTitle,
    });
    handleDetectedShow({ title: movieTitle, showId: titleId, mediaType: 'movie' });
    finalizePrimeVideoMovieResponses(titleId, movieTitle, data);
    return;
  }
  const responseMetadata = findPrimeVideoEpisodeMetadata(data);
  const expectedShowTitle = responseMetadata?.seriesTitle || state.showId || readPrimeVideoSeriesTitle(document);
  const responseEpisodeTitle = responseMetadata?.episodeTitle || findPrimeVideoEpisodeTitle(data, expectedShowTitle);
  if (responseMetadata) {
    state.primeVideoMetadataByTitleId.set(titleId, { ...responseMetadata, episodeTitle: responseEpisodeTitle });
  }
  if (responseEpisodeTitle) {
    state.primeVideoEpisodeTitleByTitleId.set(titleId, responseEpisodeTitle);
    const mapped = state.primeVideoTitleMap.get(titleId);
    if (mapped) {
      refreshPrimeVideoEpisodeTitle(mapped.showId, mapped.season, mapped.episode, responseEpisodeTitle);
      recordProviderEpisode({
        providerId: titleId,
        season: mapped.season,
        episode: mapped.episode,
        title: responseEpisodeTitle,
      }, mapped.showId);
    }
  }
  if (!hasPrimeVideoSegmentEvents(data)) {
    logPrimeVideo('Playback metadata contained no supported segment events:', { titleId, eventTypes: (data?.transitionTimecodes?.result?.events || []).map(getPrimeVideoEventType) });
    return;
  }
  if (state.primeVideoTitleMap.has(titleId)) {
    const { season, episode, episodeTitle, showId } = state.primeVideoTitleMap.get(titleId);
    setPrimeVideoActiveEpisode({ season, episode, episodeTitle, showId });
    settlePrimeVideoPlaybackFallbacks(titleId);
    finalizePrimeVideoEvents(titleId, season, episode, data, episodeTitle, showId);
    return;
  }
  if (!state.primeVideoPendingByTitleId.has(titleId)) state.primeVideoPendingByTitleId.set(titleId, []);
  state.primeVideoPendingByTitleId.get(titleId).push(data);
  const metadata = responseMetadata || state.primeVideoMetadataByTitleId.get(titleId);
  if (metadata) {
    commitPrimeVideoEpisode(titleId, {
      ...metadata,
      episodeTitle: metadata.episodeTitle || state.primeVideoEpisodeTitleByTitleId.get(titleId) || '',
      title: metadata.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const currentDetailId = readCurrentPrimeVideoDetailId();
  const detailSnapshot = currentDetailId && state.primeVideoDetailMap.get(currentDetailId);
  const detailPlaybackTitleId = currentDetailId && state.primeVideoPlaybackTitleByDetailId.get(currentDetailId);
  if (detailSnapshot && (!detailPlaybackTitleId || detailPlaybackTitleId === titleId)) {
    commitPrimeVideoEpisode(titleId, {
      ...detailSnapshot,
      title: detailSnapshot.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const selectedSnapshot = state.primeVideoSelectedEpisode;
  const selectionIsCurrent = selectedSnapshot && selectedSnapshot.resolvedTitleId == null &&
    Date.now() - selectedSnapshot.selectedAt < PRIME_VIDEO_SELECTION_TTL_MS;
  if (selectionIsCurrent) {
    commitPrimeVideoEpisode(titleId, {
      ...selectedSnapshot,
      title: selectedSnapshot.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const inferredSnapshot = inferNextPrimeVideoEpisode();
  if (inferredSnapshot) {
    inferredSnapshot.episodeTitle ||= state.primeVideoEpisodeTitleByTitleId.get(titleId) || '';
    logPrimeVideo('Inferred next episode from the scanned season boundary:', {
      titleId,
      season: inferredSnapshot.season,
      episode: inferredSnapshot.episode,
    });
    commitPrimeVideoEpisode(titleId, inferredSnapshot, { allowNumberReuse: true });
    return;
  }
  if (!state.primeVideoPollingTitleIds.has(titleId)) {
    state.primeVideoPollingTitleIds.add(titleId);
    pollPrimeVideoEpisode(titleId, 0);
  }
}

export function setupPrimeVideoInterception() {
  ensurePrimeVideoState();
  const scanCatalog = () => {
    if (document.hidden) return;
    try {
      scanPrimeVideoEpisodeCatalog();
      preloadPrimeVideoSeasonCatalogs();
    }
    catch (error) { console.warn('[PVE] Failed to scan episode catalogue:', error); }
  };
  scanCatalog();
  setInterval(scanCatalog, PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS);
  if (typeof MutationObserver === 'function') {
    let scanTimer = null;
    const observer = new MutationObserver(records => {
      if (records.every(record => record.target.closest?.('[id^="nfe-"]'))) return;
      if (scanTimer != null) return;
      scanTimer = setTimeout(() => { scanTimer = null; scanCatalog(); }, PRIME_VIDEO_POLL_INTERVAL_MS);
    });
    observer.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label'],
    });
  }
  document.addEventListener('click', event => {
    const card = event.target?.closest?.(PRIME_VIDEO_CARD_SELECTOR);
    if (card) rememberPrimeVideoEpisodeSelection(card);
  }, true);
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OriginalXHR = win.XMLHttpRequest;

  function PrimeVideoInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    let bodyText = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = String(requestUrl || '');
      return originalOpen(method, requestUrl, ...rest);
    };
    xhr.send = function (body, ...rest) {
      bodyText = readPrimeVideoRequestBody(body);
      if (isPrimeVideoMetadataUrl(url)) {
        logPrimeVideo('Intercepted Prime Video playback XHR:', { url });
        xhr.addEventListener('load', () => {
          try { processPrimeVideoMetadata(JSON.parse(xhr.responseText), bodyText, url); }
          catch (error) { console.error('[PVE] Failed to process XHR response:', error); }
        });
      }
      return originalSend(body, ...rest);
    };
    return xhr;
  }
  Object.setPrototypeOf(PrimeVideoInterceptedXHR, OriginalXHR);
  PrimeVideoInterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = PrimeVideoInterceptedXHR;

  const originalFetch = win.fetch.bind(win);
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ? String(input.url) : String(input || ''));
    if (!isPrimeVideoMetadataUrl(url)) return originalFetch(input, init);

    return (async () => {
      logPrimeVideo('Intercepted Prime Video playback fetch:', { url });
      const bodyText = await readPrimeVideoFetchRequestBody(input, init);
      const response = await originalFetch(input, init);
      try { processPrimeVideoMetadata(await response.clone().json(), bodyText, url); }
      catch (error) { console.error('[PVE] Failed to process fetch response:', error); }
      return response;
    })();
  };
  logPrimeVideo('Prime Video interception initialized.', {
    page: String(win.location?.href || (typeof location !== 'undefined' ? location.href : '')),
    xhr: typeof OriginalXHR === 'function',
    fetch: typeof win.fetch === 'function',
  });
}
