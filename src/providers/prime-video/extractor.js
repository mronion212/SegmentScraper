/** Prime Video catalogue, playback-resource, and timestamp extraction. */

import { state } from '../../core/state.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';
import { recordProviderEpisode } from '../../core/tvdb.js';

const PRIME_VIDEO_METADATA_URL_MATCH = 'GetVodPlaybackResources';
const PRIME_VIDEO_ID_PATTERN = /^(?:[A-Z0-9]{9,12}|amzn1\.dv\.gti\.[a-f0-9-]{20,})$/i;
const PRIME_VIDEO_CARD_SELECTOR = '[data-testid="episode-list-item"], li[id^="av-ep-episode-"]';
const PRIME_VIDEO_EPISODE_HEADING_PATTERN = /^\s*(\d+)\s*[.\-:]\s*(.*?)\s*$/;
const PRIME_VIDEO_POLL_INTERVAL_MS = 250;
const PRIME_VIDEO_MAX_POLL_ATTEMPTS = 40;
const PRIME_VIDEO_SELECTION_TTL_MS = 60000;
const PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS = 1000;

function isPrimeVideoTitleId(value) {
  return typeof value === 'string' && PRIME_VIDEO_ID_PATTERN.test(value);
}

function ensurePrimeVideoState() {
  if (!(state.primeVideoTitleMap instanceof Map)) state.primeVideoTitleMap = new Map();
  if (!(state.primeVideoPendingByTitleId instanceof Map)) state.primeVideoPendingByTitleId = new Map();
  if (!(state.primeVideoDetailMap instanceof Map)) state.primeVideoDetailMap = new Map();
  if (!(state.primeVideoPollingTitleIds instanceof Set)) state.primeVideoPollingTitleIds = new Set();
  if (!(state.primeVideoPendingOutroTitleIds instanceof Set)) state.primeVideoPendingOutroTitleIds = new Set();
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
  const seen = new Set();
  let found = 0;

  for (const card of cards) {
    const cardEpisode = readPrimeVideoCardEpisode(card);
    const titleId = readPrimeVideoCardTitleId(card);
    if (!cardEpisode || !titleId || seen.has(titleId)) continue;
    seen.add(titleId);

    const snapshot = { season, ...cardEpisode, showId };
    state.primeVideoTitleMap.set(titleId, snapshot);
    const detailId = readPrimeVideoCardDetailId(card);
    if (detailId) state.primeVideoDetailMap.set(detailId, { ...snapshot, seriesTitle });
    recordProviderEpisode({ providerId: titleId, season, episode: cardEpisode.episode, title: cardEpisode.episodeTitle }, showId);
    found++;
  }
  return found;
}

function findPrimeVideoEpisodeCollision(titleId, showId, season, episode) {
  for (const [knownTitleId, known] of state.primeVideoTitleMap) {
    if (knownTitleId !== titleId && known.showId === showId && known.season === season && known.episode === episode) return known;
  }
  return null;
}

function formatPrimeVideoTimestamp(milliseconds) {
  const totalMilliseconds = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const millis = totalMilliseconds % 1000;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock;
}

function coercePrimeVideoMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readPrimeVideoEventTimeMs(event, boundary) {
  const keys = boundary === 'start'
    ? ['startTimeMs', 'startTimecodeMs', 'startTimeCodeMs', 'startMs']
    : ['endTimeMs', 'endTimecodeMs', 'endTimeCodeMs', 'endMs'];
  for (const key of keys) {
    const value = coercePrimeVideoMilliseconds(event?.[key]);
    if (value != null) return value;
  }
  return null;
}

function findPrimeVideoRuntimeMs(root, events = []) {
  const candidates = events
    .map(event => readPrimeVideoEventTimeMs(event, 'end'))
    .filter(value => value != null);
  const visited = new WeakSet();
  const millisecondKeys = new Set(['runtimems', 'runtimemillis', 'runtimemilliseconds', 'durationms', 'durationmillis', 'durationmilliseconds']);
  const secondKeys = new Set(['runtimeseconds', 'runtimeinseconds', 'durationseconds', 'durationinseconds']);

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
    visited.add(node);
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        if (millisecondKeys.has(normalizedKey)) candidates.push(number);
        if (secondKeys.has(normalizedKey)) candidates.push(number * 1000);
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

function logPrimeVideoTimestamps(titleId, showId, season, episode, episodeTitle, items) {
  if (!items.length) return;
  const episodeLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  console.info(`[PVE] Captured timestamps · ${showId || 'Unknown series'} · ${episodeLabel}`, {
    title: episodeTitle || '',
    titleId,
    segments: items.map(item => ({
      type: item.segment_type,
      start: formatPrimeVideoTimestamp(item.start_sec * 1000),
      end: formatPrimeVideoTimestamp(item.end_sec * 1000),
      start_sec: item.start_sec,
      end_sec: item.end_sec,
    })),
  });
}

function appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, segmentType, startTimeMs, endTimeMs) {
  const episodeId = `${titleId}_${segmentType}`;
  const alreadyCaptured = item => item._eid === episodeId || (
    item._showId === showId &&
    item.season === season &&
    item.episode === episode &&
    item.segment_type === segmentType
  );
  if (state.allItems.some(alreadyCaptured) || extractedItems.some(alreadyCaptured)) return false;
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: episodeTitle,
    _showId: showId,
    imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
    segment_type: segmentType,
    season,
    episode,
    start_sec: startTimeMs / 1000,
    end_sec: endTimeMs / 1000,
  });
  return true;
}

function pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs, attempt = 0) {
  const endTimeMs = readPrimeVideoMediaDurationMs();
  if (endTimeMs != null && endTimeMs > startTimeMs) {
    const extractedItems = [];
    appendPrimeVideoSegment(extractedItems, titleId, showId, season, episode, episodeTitle, 'outro', startTimeMs, endTimeMs);
    state.primeVideoPendingOutroTitleIds.delete(titleId);
    logPrimeVideoTimestamps(titleId, showId, season, episode, episodeTitle, extractedItems);
    recordExtractedSegments(extractedItems);
    return;
  }
  if (attempt >= PRIME_VIDEO_MAX_POLL_ATTEMPTS) {
    state.primeVideoPendingOutroTitleIds.delete(titleId);
    console.warn('[PVE] NEXT_UP had a start time, but no episode duration could be resolved:', titleId);
    return;
  }
  setTimeout(
    () => pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs, attempt + 1),
    PRIME_VIDEO_POLL_INTERVAL_MS
  );
}

function finalizePrimeVideoEvents(titleId, season, episode, data, episodeTitle = '', showId = state.showId) {
  const events = data?.transitionTimecodes?.result?.events || [];
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
  const outroCandidates = events.filter(event => event.eventType === 'END_CREDITS' || event.eventType === 'NEXT_UP');
  const outroRange = outroCandidates
    .filter(event => event.eventType === 'END_CREDITS')
    .map(event => resolveEventRange(event, true))
    .find(Boolean) || outroCandidates
    .filter(event => event.eventType === 'NEXT_UP')
    .map(event => resolveEventRange(event, true))
    .find(Boolean);

  for (const event of events) {
    let segmentType = null;
    if (event.eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (event.eventType === 'SKIP_INTRO') segmentType = 'intro';
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
      pollPrimeVideoOutroDuration(titleId, showId, season, episode, episodeTitle, startTimeMs);
    } else if (startTimeMs == null) {
      console.warn('[PVE] Prime returned an outro event without a usable start time:', outroCandidates);
    }
  }
  logPrimeVideoTimestamps(titleId, showId, season, episode, episodeTitle, extractedItems);
  recordExtractedSegments(extractedItems);
}

function commitPrimeVideoEpisode(titleId, snapshot, { allowNumberReuse = false } = {}) {
  const showId = updatePrimeVideoTitle(snapshot.seriesTitle || snapshot.title);
  const collision = findPrimeVideoEpisodeCollision(titleId, showId, snapshot.season, snapshot.episode);
  if (collision && !allowNumberReuse) return false;

  const episodeTitle = snapshot.episodeTitle || '';
  state.primeVideoTitleMap.set(titleId, { season: snapshot.season, episode: snapshot.episode, episodeTitle, showId });
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
  if (!titleId) return;
  if (state.primeVideoTitleMap.has(titleId)) {
    const { season, episode, episodeTitle, showId } = state.primeVideoTitleMap.get(titleId);
    finalizePrimeVideoEvents(titleId, season, episode, data, episodeTitle, showId);
    return;
  }
  if (!state.primeVideoPendingByTitleId.has(titleId)) state.primeVideoPendingByTitleId.set(titleId, []);
  state.primeVideoPendingByTitleId.get(titleId).push(data);
  const metadata = findPrimeVideoEpisodeMetadata(data);
  if (metadata) {
    commitPrimeVideoEpisode(titleId, {
      ...metadata,
      title: metadata.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const currentDetailId = readCurrentPrimeVideoDetailId();
  const detailSnapshot = currentDetailId && state.primeVideoDetailMap.get(currentDetailId);
  if (detailSnapshot) {
    commitPrimeVideoEpisode(titleId, {
      ...detailSnapshot,
      title: detailSnapshot.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  const selectedSnapshot = state.primeVideoSelectedEpisode;
  if (selectedSnapshot && Date.now() - selectedSnapshot.selectedAt < PRIME_VIDEO_SELECTION_TTL_MS) {
    commitPrimeVideoEpisode(titleId, {
      ...selectedSnapshot,
      title: selectedSnapshot.seriesTitle || document.title,
    }, { allowNumberReuse: true });
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
    try { scanPrimeVideoEpisodeCatalog(); }
    catch (error) { console.warn('[PVE] Failed to scan episode catalogue:', error); }
  };
  scanCatalog();
  setInterval(scanCatalog, PRIME_VIDEO_CATALOG_SCAN_INTERVAL_MS);
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
      bodyText = typeof body === 'string' ? body : '';
      if (url && url.includes(PRIME_VIDEO_METADATA_URL_MATCH)) {
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
  win.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ? String(input.url) : String(input || ''));
    let bodyText = '';
    if (url.includes(PRIME_VIDEO_METADATA_URL_MATCH)) {
      try {
        if (init && typeof init.body === 'string') bodyText = init.body;
        else if (input && typeof input === 'object' && input.clone) bodyText = await input.clone().text().catch(() => '');
      } catch (_) {}
    }
    const response = await originalFetch(input, init);
    if (url.includes(PRIME_VIDEO_METADATA_URL_MATCH)) {
      try { processPrimeVideoMetadata(await response.clone().json(), bodyText, url); }
      catch (error) { console.error('[PVE] Failed to process fetch response:', error); }
    }
    return response;
  };
}
