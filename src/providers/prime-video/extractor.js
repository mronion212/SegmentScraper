/**
 * Prime Video-specific extraction logic.
 * Captures GetVodPlaybackResources transition timecodes and resolves the
 * episode number from the active player DOM.
 */

import { state } from '../../core/state.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';

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

function readPrimeVideoSeasonEpisode() {
  const player = document.getElementById('dv-web-player');
  const episodeInfo = document.querySelector('[class*="atvwebplayersdk-episode-info"]');
  const isPlayerActive = !!player && player.offsetWidth > 0 && player.offsetHeight > 0;
  let season = null;
  let episode = null;

  if (episodeInfo) {
    const text = episodeInfo.textContent.trim();
    const seasonMatch = text.match(/S(\d+)/i);
    const episodeMatch = text.match(/(?:Afl\.?|E)\s*(\d+)/i);
    if (seasonMatch) season = parseInt(seasonMatch[1], 10);
    if (episodeMatch) episode = parseInt(episodeMatch[1], 10);
  }
  return { isPlayerActive, season, episode, title: document.title };
}

function updatePrimeVideoTitle(rawTitle) {
  const cleaned = rawTitle.replace(/^Prime Video[:\-]\s*/i, '').trim();
  const seasonMatch = cleaned.match(/\s*(Seizoen|Season)\s*(\d+)/i);
  const title = seasonMatch ? cleaned.slice(0, seasonMatch.index).trim() : cleaned;
  handleDetectedShow({ title, showId: title });
}

function finalizePrimeVideoEvents(asin, season, episode, data) {
  const events = data?.transitionTimecodes?.result?.events || [];
  const extractedItems = [];

  for (const event of events) {
    let segmentType = null;
    if (event.eventType === 'SKIP_RECAP') segmentType = 'recap';
    if (event.eventType === 'SKIP_INTRO') segmentType = 'intro';
    if (!segmentType || typeof event.startTimeMs !== 'number' || typeof event.endTimeMs !== 'number') continue;

    const episodeId = `${asin}_${segmentType}`;
    if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;
    extractedItems.push({
      _eid: episodeId,
      imdb_id: state.imdbId || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: event.startTimeMs / 1000,
      end_sec: event.endTimeMs / 1000,
    });
  }
  recordExtractedSegments(extractedItems);
}

function pollPrimeVideoEpisode(asin, attempt) {
  const snapshot = readPrimeVideoSeasonEpisode();
  if (snapshot.isPlayerActive && snapshot.season != null && snapshot.episode != null) {
    state.asinMap.set(asin, { season: snapshot.season, episode: snapshot.episode });
    state.currentSeason = snapshot.season;
    state.currentEpisode = snapshot.episode;
    updatePrimeVideoTitle(snapshot.title);
    const pending = state.pendingByAsin.get(asin) || [];
    state.pendingByAsin.delete(asin);
    pending.forEach(data => finalizePrimeVideoEvents(asin, snapshot.season, snapshot.episode, data));
    return;
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
    const { season, episode } = state.asinMap.get(asin);
    finalizePrimeVideoEvents(asin, season, episode, data);
    return;
  }
  if (!state.pendingByAsin.has(asin)) state.pendingByAsin.set(asin, []);
  state.pendingByAsin.get(asin).push(data);
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
