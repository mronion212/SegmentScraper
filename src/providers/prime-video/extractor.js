/**
 * Prime Video-specific extraction logic.
 * Captures GetVodPlaybackResources transition timecodes and resolves the
 * episode number from the active player DOM.
 */

import { state } from '../../core/state.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';
import { recordProviderEpisode } from '../../core/tvdb.js';

const PRIME_VIDEO_METADATA_URL_MATCH = 'GetVodPlaybackResources';

function ensurePrimeVideoState() {
  if (!(state.asinMap instanceof Map)) state.asinMap = new Map();
  if (!(state.pendingByAsin instanceof Map)) state.pendingByAsin = new Map();
  if (state.currentSeason == null) state.currentSeason = 1;
  if (state.currentEpisode == null) state.currentEpisode = 1;
}

function findPrimeVideoAsinInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const keys = ['asin', 'ASIN', 'titleId', 'titleID', 'contentId', 'catalogId'];
  for (const key of keys) {
    if (typeof obj[key] === 'string' && /^[A-Z0-9]{9,12}$/i.test(obj[key])) return obj[key];
  }
  for (const key in obj) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      const found = findPrimeVideoAsinInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractPrimeVideoAsin(bodyText, url) {
  if (url) {
    const titleIdMatch = url.match(/[?&]titleId=([^&]+)/i);
    if (titleIdMatch) return decodeURIComponent(titleIdMatch[1]);
    const asinMatch = url.match(/[?&](?:asin|ASIN)=([A-Z0-9]{9,12})/i);
    if (asinMatch) return asinMatch[1];
  }
  if (!bodyText) return null;
  try {
    const found = findPrimeVideoAsinInObject(JSON.parse(bodyText));
    if (found) return found;
  } catch (_) {}

  const patterns = [
    /"asin"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /"titleId"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /"titleID"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /"contentId"\s*:\s*"([A-Z0-9]{9,12})"/i,
    /asin=([A-Z0-9]{9,12})/i,
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

function readPrimeVideoSeasonEpisode() {
  const player = document.getElementById('dv-web-player');
  const episodeInfo = document.querySelector('[class*="atvwebplayersdk-episode-info"]');
  const isPlayerActive = !!player && player.offsetWidth > 0 && player.offsetHeight > 0;
  let season = null;
  let episode = null;
  let episodeTitle = '';

  if (episodeInfo) {
    const text = episodeInfo.textContent.trim();
    const seasonMatch = text.match(/S(\d+)/i);
    const episodeMatch = text.match(/(?:Afl\.?|E)\s*(\d+)/i);
    if (seasonMatch) season = parseInt(seasonMatch[1], 10);
    if (episodeMatch) episode = parseInt(episodeMatch[1], 10);
    const titleNode = episodeInfo.querySelector('[class*="title" i]');
    const rawEpisodeTitle = (titleNode?.textContent || text).trim();
    episodeTitle = rawEpisodeTitle
      .replace(/^\s*S\d+\s*(?:E|Afl\.?)\s*\d+\s*[-:|.]?\s*/i, '')
      .replace(/^\s*(?:Episode|Aflevering)\s*\d+\s*[-:|.]?\s*/i, '')
      .trim();
    if (episodeTitle === rawEpisodeTitle && seasonMatch && episodeMatch) episodeTitle = '';
  }
  return { isPlayerActive, season, episode, title: document.title, episodeTitle };
}

function updatePrimeVideoTitle(rawTitle) {
  const cleaned = rawTitle.replace(/^Prime Video[:\-]\s*/i, '').trim();
  const seasonMatch = cleaned.match(/\s*(Seizoen|Season)\s*(\d+)/i);
  const title = seasonMatch ? cleaned.slice(0, seasonMatch.index).trim() : cleaned;
  handleDetectedShow({ title, showId: title });
  return title;
}

function findPrimeVideoEpisodeCollision(asin, showId, season, episode) {
  for (const [knownAsin, known] of state.asinMap) {
    if (knownAsin !== asin && known.showId === showId && known.season === season && known.episode === episode) return known;
  }
  return null;
}

function finalizePrimeVideoEvents(asin, season, episode, data, episodeTitle = '', showId = state.showId) {
  const events = data?.transitionTimecodes?.result?.events || [];
  const extractedItems = [];

  for (const event of events) {
    let segmentType = null;
    if (event.eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (event.eventType === 'SKIP_INTRO') segmentType = 'intro';
    if (!segmentType || typeof event.startTimeMs !== 'number' || typeof event.endTimeMs !== 'number') continue;

    const episodeId = `${asin}_${segmentType}`;
    const alreadyCaptured = item => item._eid === episodeId || (
      item._showId === showId &&
      item.season === season &&
      item.episode === episode &&
      item.segment_type === segmentType
    );
    if (state.allItems.some(alreadyCaptured) || extractedItems.some(alreadyCaptured)) continue;
    extractedItems.push({
      _eid: episodeId,
      _episodeTitle: episodeTitle,
      _showId: showId,
      imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: event.startTimeMs / 1000,
      end_sec: event.endTimeMs / 1000,
    });
  }
  recordExtractedSegments(extractedItems);
}

function commitPrimeVideoEpisode(asin, snapshot, { allowNumberReuse = false } = {}) {
  const showId = updatePrimeVideoTitle(snapshot.seriesTitle || snapshot.title);
  const collision = findPrimeVideoEpisodeCollision(asin, showId, snapshot.season, snapshot.episode);
  if (collision && !allowNumberReuse) return false;

  const episodeTitle = snapshot.episodeTitle || '';
  state.asinMap.set(asin, { season: snapshot.season, episode: snapshot.episode, episodeTitle, showId });
  state.currentSeason = snapshot.season;
  state.currentEpisode = snapshot.episode;
  if (!collision) {
    recordProviderEpisode({ providerId: asin, season: snapshot.season, episode: snapshot.episode, title: episodeTitle }, showId);
  }
  const pending = state.pendingByAsin.get(asin) || [];
  state.pendingByAsin.delete(asin);
  pending.forEach(data => finalizePrimeVideoEvents(asin, snapshot.season, snapshot.episode, data, episodeTitle, showId));
  return true;
}

function pollPrimeVideoEpisode(asin, attempt) {
  const snapshot = readPrimeVideoSeasonEpisode();
  if (snapshot.isPlayerActive && snapshot.season != null && snapshot.episode != null) {
    if (commitPrimeVideoEpisode(asin, snapshot)) return;
  }
  if (attempt >= 40) {
    console.warn('[PVE] Could not resolve season/episode for ASIN:', asin);
    state.pendingByAsin.delete(asin);
    return;
  }
  setTimeout(() => pollPrimeVideoEpisode(asin, attempt + 1), 250);
}

export function processPrimeVideoMetadata(data, bodyText, url) {
  ensurePrimeVideoState();
  const asin = extractPrimeVideoAsin(bodyText, url);
  if (!asin) return;
  if (state.asinMap.has(asin)) {
    const { season, episode, episodeTitle, showId } = state.asinMap.get(asin);
    finalizePrimeVideoEvents(asin, season, episode, data, episodeTitle, showId);
    return;
  }
  if (!state.pendingByAsin.has(asin)) state.pendingByAsin.set(asin, []);
  state.pendingByAsin.get(asin).push(data);
  const metadata = findPrimeVideoEpisodeMetadata(data);
  if (metadata) {
    commitPrimeVideoEpisode(asin, {
      ...metadata,
      title: metadata.seriesTitle || document.title,
    }, { allowNumberReuse: true });
    return;
  }
  pollPrimeVideoEpisode(asin, 0);
}

export function setupPrimeVideoInterception() {
  ensurePrimeVideoState();
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OriginalXHR = win.XMLHttpRequest;

  function PrimeVideoInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    let bodyText = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = requestUrl;
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
    const url = typeof input === 'string' ? input : (input && input.url) || '';
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
