/**
 * Videoland-specific extraction logic.
 * Captures /layout responses and joins root episode metadata to video chapters.
 */

import { state } from '../../core/state.js';
import { splitCreditRange } from '../../normalization/segment-mapper.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';
import { recordProviderEpisode } from '../../core/tvdb.js';
import { logCapturedTimestamps } from '../timestamp-logger.js';

const VIDEOLAND_LAYOUT_URL_MATCH = /\/layout(\?|$)/i;

function ensureVideolandState() {
  if (!(state.clipMap instanceof Map)) state.clipMap = new Map();
  if (state.currentSeason == null) state.currentSeason = 1;
  if (state.currentEpisode == null) state.currentEpisode = 1;
}

function coerceVideolandNumber(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

function extractVideolandRootMeta(json) {
  const video = json?.seo?.video || null;
  const entity = json?.entity || null;
  const parent = json?.seo?.parent || json?.parent || null;
  const type = String(
    json?.mediaType || json?.type || json?.videoType || json?.contentType ||
    json?.seo?.mediaType || json?.seo?.type || json?.seo?.contentType ||
    video?.mediaType || video?.type || video?.videoType || video?.contentType ||
    entity?.mediaType || entity?.type || entity?.videoType || entity?.contentType || ''
  ).trim().toLowerCase();
  return {
    entityId: entity?.id != null ? String(entity.id) : null,
    entity,
    mediaType: json?.isMovie === true || video?.isMovie === true || entity?.isMovie === true || ['movie', 'film', 'feature'].includes(type)
      ? 'movie'
      : 'tv',
    season: coerceVideolandNumber(video?.season ?? entity?.season ?? json?.season),
    episode: coerceVideolandNumber(video?.episode ?? entity?.episode ?? json?.episode),
    duration: coerceVideolandNumber(video?.duration ?? entity?.duration ?? json?.duration),
    programId: parent?.id != null
      ? String(parent.id)
      : (json?.programId ?? entity?.programId ?? entity?.seriesId) != null
        ? String(json?.programId ?? entity?.programId ?? entity?.seriesId)
        : null,
    programTitle: parent?.name || json?.programTitle || json?.seriesTitle || null,
    episodeTitle: video?.name || video?.title || entity?.episodeTitle || entity?.episodeName || null,
    extraTitle: video?.extraTitle || entity?.extraTitle || null,
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

function isVideolandMovieCreditsType(type) {
  return [
    'ending_credits',
    'endingcredits',
    'end_credits',
    'endcredits',
    'closing_credits',
    'closingcredits',
    'credits',
  ].includes(String(type || '').trim().toLowerCase());
}

function updateVideolandTitle(title, programId, mediaType = 'tv') {
  const showId = String(programId || title);
  handleDetectedShow({ title, showId, mediaType });
  return showId;
}

function normalizeVideolandEpisodeTitle(value) {
  return String(value || '').trim().replace(/^\d+\s*\.\s*/, '').trim();
}

function isVideolandGtstSeries(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() === 'goede tijden slechte tijden';
}

function chooseVideolandEpisodeTitle(rootMeta, activeItem, programTitle) {
  const candidates = [
    rootMeta?.entity?.extraTitle,
    rootMeta?.entity?.episodeTitle,
    rootMeta?.entity?.episodeName,
    rootMeta?.entity?.subtitle,
    rootMeta?.entity?.subTitle,
    rootMeta?.entity?.secondaryTitle,
    rootMeta?.entity?.title,
    rootMeta?.entity?.name,
    activeItem?.episodeTitle,
    activeItem?.episodeName,
    activeItem?.extraTitle,
    activeItem?.subtitle,
    activeItem?.subTitle,
    activeItem?.secondaryTitle,
    activeItem?.video?.episodeTitle,
    activeItem?.video?.episodeName,
    activeItem?.video?.extraTitle,
    activeItem?.video?.subtitle,
    activeItem?.video?.subTitle,
    activeItem?.video?.secondaryTitle,
    activeItem?.title,
    activeItem?.video?.title,
    activeItem?.video?.name,
    rootMeta?.extraTitle,
    rootMeta?.episodeTitle,
  ].map(normalizeVideolandEpisodeTitle).filter(Boolean);
  const normalizedProgramTitle = String(programTitle || '').trim().toLocaleLowerCase();
  return candidates.find(candidate => candidate.toLocaleLowerCase() !== normalizedProgramTitle) || '';
}

export function processVideolandLayout(json) {
  ensureVideolandState();
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
  const hasMovieCreditsChapter = (activeItem.video.chapters || []).some(chapter => isVideolandMovieCreditsType(chapter.type));
  const isMovie = rootMeta.mediaType === 'movie' || (season == null && episode == null && hasMovieCreditsChapter);
  const title = (rootMeta.programTitle || rootMeta.episodeTitle || activeItem.title || activeItem.video.title || activeItem.video.name || '').trim();
  const mediaId = isMovie ? (rootMeta.programId || rootMeta.entityId || clipId) : rootMeta.programId;
  const episodeTitle = chooseVideolandEpisodeTitle(rootMeta, activeItem, title);
  if (isMovie) {
    console.info('[VLE] Movie metadata classified; skipping TVDB mapping.', {
      title,
      showId: mediaId,
      clipId,
    });
  }
  if (!isMovie && !episodeTitle) {
    console.warn('[VLE] No episode-specific title found; the series title will not be used for TVDB matching.', {
      clipId,
      seriesTitle: title,
    });
  }
  const showId = updateVideolandTitle(title, mediaId, isMovie ? 'movie' : 'tv');
  const useGtstAbsoluteTitleMatch = isVideolandGtstSeries(title);
  state.clipMap.set(clipId, { season, episode, title, showId, mediaType: isMovie ? 'movie' : 'tv' });

  if (isMovie) {
    const extractedItems = [];
    const chapters = activeItem.video.chapters || [];
    const afterCreditsChapters = chapters.filter(chapter => [
      'after_credits',
      'aftercredits',
      'after_credits_scene',
      'aftercreditsscene',
      'post_credits',
      'postcredits',
      'post_credits_scene',
      'postcreditsscene',
    ].includes(String(chapter.type || '').trim().toLowerCase()));
    const afterCreditsChapter = afterCreditsChapters.slice().sort((a, b) => Number(a.tcStart) - Number(b.tcStart))[0];
    const creditChapters = chapters.filter(chapter => isVideolandMovieCreditsType(chapter.type)
      && coerceVideolandNumber(chapter.tcStart) != null && coerceVideolandNumber(chapter.tcEnd) != null
      && Number(chapter.tcEnd) > Number(chapter.tcStart));
    const fullCredits = creditChapters.length ? [{
      type: creditChapters[0].type,
      tcStart: Math.min(...creditChapters.map(chapter => Number(chapter.tcStart))),
      tcEnd: Math.max(...creditChapters.map(chapter => Number(chapter.tcEnd))),
    }] : [];
    for (const chapter of fullCredits) {
      const chapterType = String(chapter.type || '').trim().toLowerCase();
      if (!isVideolandMovieCreditsType(chapterType)) continue;
      const startSec = coerceVideolandNumber(chapter.tcStart);
      const endSec = coerceVideolandNumber(chapter.tcEnd);
      if (startSec == null || endSec == null || endSec <= startSec) continue;

      const ranges = splitCreditRange({
        startSec,
        endSec,
        afterCreditsDetected: afterCreditsChapters.length > 0,
        afterCreditsStartSec: coerceVideolandNumber(afterCreditsChapter?.tcStart),
        afterCreditsEndSec: coerceVideolandNumber(afterCreditsChapter?.tcEnd),
      });
      for (const range of ranges) {
        const episodeId = `${clipId}_movie_${range.segmentType || 'outro'}${range.creditPart ? `_${range.creditPart}` : ''}`;
        if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;
        extractedItems.push({
          _eid: episodeId,
          _episodeTitle: title,
          _showId: showId,
          media_type: 'movie',
          ...(range.creditPart ? { credit_part: range.creditPart } : {}),
          imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
          segment_type: range.segmentType || 'outro',
          season: null,
          episode: null,
          start_sec: range.startSec,
          end_sec: range.endSec,
        });
      }
    }
    logCapturedTimestamps({
      prefix: 'VLE',
      showTitle: title,
      mediaType: 'movie',
      episodeTitle: title,
      providerIdLabel: 'clipId',
      providerId: clipId,
      items: extractedItems,
    });
    recordExtractedSegments(extractedItems);
    return;
  }

  if (season != null && episode != null) {
    state.currentSeason = season;
    state.currentEpisode = episode;
  }
  recordProviderEpisode({ providerId: clipId, season, episode, title: episodeTitle }, showId);

  if (season == null || episode == null) return;
  const extractedItems = [];
  for (const chapter of activeItem.video.chapters || []) {
    const segmentType = mapVideolandChapterType(chapter.type);
    const startSec = coerceVideolandNumber(chapter.tcStart);
    const endSec = coerceVideolandNumber(chapter.tcEnd);
    if (!segmentType || startSec == null || endSec == null) continue;

    const episodeId = `${clipId}_${segmentType}`;
    if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;
    extractedItems.push({
      _eid: episodeId,
      _episodeTitle: episodeTitle,
      _showId: showId,
      _tvdbEpisodeLanguages: ['eng', 'nld'],
      ...(useGtstAbsoluteTitleMatch ? { _tvdbAbsoluteTitleMatch: true } : {}),
      imdb_id: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
      segment_type: segmentType,
      season,
      episode,
      start_sec: startSec,
      end_sec: endSec,
    });
  }
  logCapturedTimestamps({
    prefix: 'VLE',
    showTitle: title,
    season,
    episode,
    episodeTitle,
    providerIdLabel: 'clipId',
    providerId: clipId,
    items: extractedItems,
  });
  recordExtractedSegments(extractedItems);
}

export function setupVideolandInterception() {
  ensureVideolandState();
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
