/**
 * Videoland-specific extraction logic.
 * Captures /layout responses and joins root episode metadata to video chapters.
 */

import { state } from '../../core/state.js';
import { searchImdbByTitle, loadExistingSegments } from '../../core/network.js';
import { setDbStatus } from '../netflix/extractor.js';
import { toast, updateCounters, updateImdbInput, updatePanelTitle } from '../../ui/panel.js';

const VIDEOLAND_LAYOUT_URL_MATCH = /\/layout(\?|$)/i;

function coerceVideolandNumber(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

function extractVideolandRootMeta(json) {
  const video = json?.seo?.video || null;
  return {
    entityId: json?.entity?.id != null ? String(json.entity.id) : null,
    season: coerceVideolandNumber(video?.season),
    episode: coerceVideolandNumber(video?.episode),
    duration: coerceVideolandNumber(video?.duration),
    programId: json?.seo?.parent?.id != null ? String(json.seo.parent.id) : null,
    programTitle: json?.seo?.parent?.name || null,
  };
}

function extractVideolandVideosWithChapters(root) {
  const found = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.itemContent?.video && Array.isArray(node.itemContent.video.chapters)) found.push(node.itemContent);
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) walk(node[key]);
    }
  }
  walk(root);
  return found;
}

function mapVideolandChapterType(type) {
  if (type === 'intro') return 'recap';
  if (type === 'opening_credits' || type === 'openingcredits') return 'intro';
  if (type === 'ending_credits' || type === 'endingcredits') return 'outro';
  return null;
}

function updateVideolandTitle(title, programId) {
  if (title && title !== state.showTitle) {
    state.showTitle = title;
    state.showId = programId;
    if (programId) state.showIds.add(programId);
    state.showYear = '';
    state.dbSearchDone = false;
    state.imdbId = '';
    state.dedupCacheV2 = {};
    updatePanelTitle();
  }

  if (!state.dbSearchDone && state.showTitle) {
    state.dbSearchDone = true;
    searchImdbByTitle(state.showTitle, state.showYear).then(result => {
      if (result.success) {
        state.imdbId = result.imdbId;
        state.allItems.forEach(item => {
          if (item.imdb_id === 'IMDB_PENDING') item.imdb_id = result.imdbId;
        });
        updateImdbInput();
        setDbStatus(`Found: ${result.imdbId}`);
        updateCounters();
        loadExistingSegments(result.imdbId);
      } else {
        setDbStatus(`IMDb lookup failed: ${result.error}`);
      }
    }).catch(error => {
      console.error('[VLE] IMDb search error:', error);
      setDbStatus('IMDb lookup error');
    });
  }
}

export function processVideolandLayout(json) {
  let rootMeta;
  let videoItems;
  try {
    rootMeta = extractVideolandRootMeta(json);
    videoItems = extractVideolandVideosWithChapters(json);
  } catch (error) {
    console.error('[VLE] Failed to traverse layout JSON:', error);
    return;
  }
  if (!videoItems.length) return;

  let activeItem = null;
  if (rootMeta.entityId) {
    activeItem = videoItems.find(item => String(item.video.id) === rootMeta.entityId);
  }
  if (!activeItem) activeItem = videoItems[0];

  const clipId = String(activeItem.video.id);
  const season = rootMeta.season;
  const episode = rootMeta.episode;
  const title = (rootMeta.programTitle || activeItem.title || '').trim();
  state.clipMap.set(clipId, { season, episode, title, programId: rootMeta.programId });

  if (season != null && episode != null) {
    state.currentSeason = season;
    state.currentEpisode = episode;
    updatePanelTitle();
  }
  updateVideolandTitle(title, rootMeta.programId);

  if (season == null || episode == null) return;
  let newItems = 0;
  for (const chapter of activeItem.video.chapters || []) {
    const segmentType = mapVideolandChapterType(chapter.type);
    const startSec = coerceVideolandNumber(chapter.tcStart);
    const endSec = coerceVideolandNumber(chapter.tcEnd);
    if (!segmentType || startSec == null || endSec == null) continue;

    const episodeId = `${clipId}_${segmentType}`;
    if (state.allItems.some(item => item._eid === episodeId)) continue;
    state.allItems.push({
      _eid: episodeId,
      imdb_id: state.imdbId || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: startSec,
      end_sec: endSec,
    });
    newItems++;
  }

  if (newItems > 0) {
    state.interceptedCount++;
    updateCounters();
    toast(`+${newItems} timestamps captured (S${season}E${episode}) · total: ${state.allItems.length}`);
  }
}

export function setupVideolandInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const originalFetch = win.fetch.bind(win);
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const responsePromise = originalFetch(input, init);
    if (VIDEOLAND_LAYOUT_URL_MATCH.test(url)) {
      responsePromise.then(response => response.clone().json())
        .then(processVideolandLayout)
        .catch(error => console.warn('[VLE] Failed to process fetch response:', error));
    }
    return responsePromise;
  };

  const OriginalXHR = win.XMLHttpRequest;
  function VideolandInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = requestUrl;
      return originalOpen(method, requestUrl, ...rest);
    };
    xhr.send = function (...args) {
      if (url && VIDEOLAND_LAYOUT_URL_MATCH.test(url)) {
        xhr.addEventListener('load', () => {
          try { processVideolandLayout(JSON.parse(xhr.responseText)); }
          catch (error) { console.error('[VLE] Failed to process XHR response:', error); }
        });
      }
      return originalSend(...args);
    };
    return xhr;
  }
  Object.setPrototypeOf(VideolandInterceptedXHR, OriginalXHR);
  VideolandInterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = VideolandInterceptedXHR;
}
