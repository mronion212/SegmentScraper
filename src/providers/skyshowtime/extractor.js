/**
 * SkyShowtime-specific catalogue interception and segment extraction.
 *
 * Catalogue responses can be requested by either the page or a dedicated
 * worker. Both paths are observed, with a Resource Timing + GM request as a
 * fallback when only the exact catalogue URL is visible to the userscript.
 */

import { state } from '../../core/state.js';
import { splitCreditRange } from '../../normalization/segment-mapper.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';
import { setProviderEpisodeCatalog } from '../../core/tvdb.js';
import { logCapturedTimestamps } from '../timestamp-logger.js';

const SKYSHOWTIME_WORKER_MESSAGE = '__segmentScraperSkyShowtime';
const SKYSHOWTIME_CATALOGUE_HOST = 'atom.skyshowtime.com';
const SKYSHOWTIME_CATALOGUE_PATH = '/adapter-calypso/';
const SKYSHOWTIME_SERIES_PATH = '/provider_series_id/';
const SKYSHOWTIME_VARIANT_PATH = '/provider_variant_id/';

function coerceSkyShowtimeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function roundSkyShowtimeSeconds(value) {
  return Math.round(value * 1000) / 1000;
}

export function isSkyShowtimeCatalogueUrl(url) {
  const value = String(url || '');
  return value.includes(SKYSHOWTIME_CATALOGUE_HOST) &&
    value.includes(SKYSHOWTIME_CATALOGUE_PATH) &&
    (value.includes(SKYSHOWTIME_SERIES_PATH) || value.includes(SKYSHOWTIME_VARIANT_PATH));
}

function looksLikeSkyShowtimeEpisode(node) {
  if (!node || typeof node !== 'object' || node.episodeNumber == null) return false;
  const hasRuntime = node.durationMilliseconds != null || node.durationSeconds != null;
  const hasContext = Boolean(node.seriesName || node.providerSeriesId || node.providerVariantId || node.episodeName);
  const hasFormats = Boolean(node.formats && typeof node.formats === 'object');
  return hasRuntime || hasContext || hasFormats;
}

function isSkyShowtimeMovieType(value) {
  return ['movie', 'film', 'feature'].includes(String(value || '').trim().toLowerCase());
}

function looksLikeSkyShowtimeMovie(node) {
  if (!node || typeof node !== 'object' || node.episodeNumber != null) return false;
  const typeValues = [
    node.mediaType,
    node.type,
    node.contentType,
    node.videoType,
    node.assetType,
    node.productType,
    node.entityType,
    node.programmeType,
    node.programType,
    node.kind,
    node.subType,
  ];
  const hasRuntime = node.durationMilliseconds != null || node.durationSeconds != null;
  const hasFormats = Boolean(node.formats && typeof node.formats === 'object');
  const hasCreditMarkers = hasFormats && Object.values(node.formats).some(format => {
    const markers = format?.markers || {};
    return ['SOCR', 'EOCR', 'EOC', 'startOfCredits', 'creditsStart'].some(key => markers[key] != null || format?.[key] != null);
  });
  const hasMovieFlag = ['isMovie', 'isFilm', 'isFeature'].some(key =>
    node[key] === true || node[key] === 1 || node[key] === 'true'
  );
  return (typeValues.some(isSkyShowtimeMovieType) || hasMovieFlag || hasCreditMarkers) && (hasRuntime || hasFormats);
}

function extendSkyShowtimeContext(context, attributes) {
  if (!attributes || typeof attributes !== 'object') return context;
  const mediaType = attributes.mediaType || attributes.type || attributes.contentType || attributes.entityType || context.mediaType;
  return {
    seasonNumber: attributes.seasonNumber ?? context.seasonNumber,
    ...(mediaType ? { mediaType } : {}),
    providerSeriesId: attributes.providerSeriesId || context.providerSeriesId,
    providerVariantId: attributes.providerVariantId || context.providerVariantId,
    programmeUuid: attributes.programmeUuid || context.programmeUuid,
    providerMovieId: attributes.providerMovieId || context.providerMovieId,
    movieId: attributes.movieId || context.movieId,
    id: attributes.id || context.id,
    seriesId: attributes.seriesId || context.seriesId,
    seriesUuid: attributes.seriesUuid || context.seriesUuid,
    seriesName: attributes.seriesName || context.seriesName,
    movieName: attributes.movieName || context.movieName,
    titleLong: attributes.titleLong || context.titleLong,
    titleMedium: attributes.titleMedium || context.titleMedium,
    title: attributes.title || context.title,
    name: attributes.name || context.name,
    durationMilliseconds: attributes.durationMilliseconds ?? context.durationMilliseconds,
    durationSeconds: attributes.durationSeconds ?? context.durationSeconds,
    year: attributes.year ?? attributes.releaseYear ?? attributes.releaseDate?.slice?.(0, 4) ?? context.year,
  };
}

function getSkyShowtimeMovieIdentifiers(movie) {
  return [
    movie?.providerVariantId,
    movie?.programmeUuid,
    movie?.providerMovieId,
    movie?.movieId,
    movie?.id,
    movie?.contentId,
    movie?.catalogId,
  ].filter(value => value != null && String(value).trim() !== '').map(value => String(value).trim());
}

function getSkyShowtimeMovieId(movie) {
  return getSkyShowtimeMovieIdentifiers(movie)[0] || '';
}

function getSkyShowtimeRequestedVariantId(sourceUrl) {
  const match = String(sourceUrl || '').match(/\/provider_variant_id\/([^/?#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Find episode attributes while inheriting series/season data from parent nodes. */
export function findSkyShowtimeEpisodes(root) {
  const found = [];
  const visited = new WeakSet();

  function walk(node, inheritedContext = {}) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, inheritedContext));
      return;
    }

    const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
    const context = extendSkyShowtimeContext(inheritedContext, attributes);
    if (looksLikeSkyShowtimeEpisode(attributes)) {
      found.push({
        ...context,
        ...attributes,
        seasonNumber: attributes.seasonNumber ?? context.seasonNumber,
        providerSeriesId: attributes.providerSeriesId || context.providerSeriesId,
        seriesId: attributes.seriesId || context.seriesId,
        seriesUuid: attributes.seriesUuid || context.seriesUuid,
        seriesName: attributes.seriesName || context.seriesName,
        year: attributes.year ?? context.year,
      });
    }

    for (const value of Object.values(node)) walk(value, context);
  }

  walk(root);
  const episodeKeys = new Set();
  return found.filter(episode => {
    const key = [
      episode.providerSeriesId || episode.seriesId || episode.seriesUuid || 'series',
      episode.seasonNumber ?? '?',
      episode.episodeNumber ?? '?',
      episode.providerVariantId || episode.programmeUuid || episode.id || episode.episodeName || 'episode',
    ].join('::');
    if (episodeKeys.has(key)) return false;
    episodeKeys.add(key);
    return true;
  });
}

/** Find explicitly typed movie records while inheriting catalogue context. */
export function findSkyShowtimeMovies(root) {
  const found = [];
  const visited = new WeakSet();

  function walk(node, inheritedContext = {}) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, inheritedContext));
      return;
    }

    const hasAttributes = node.attributes && typeof node.attributes === 'object';
    const attributes = hasAttributes
      ? { ...node.attributes, ...(node.id != null && node.attributes.id == null ? { id: node.id } : {}) }
      : node;
    const context = extendSkyShowtimeContext(inheritedContext, attributes);
    const candidate = { ...context, ...attributes };
    if (looksLikeSkyShowtimeMovie(candidate)) {
      found.push({
        ...candidate,
        providerVariantId: attributes.providerVariantId || context.providerVariantId,
        seriesId: attributes.seriesId || context.seriesId,
        seriesUuid: attributes.seriesUuid || context.seriesUuid,
        seriesName: attributes.seriesName || context.seriesName,
        year: attributes.year ?? attributes.releaseYear ?? attributes.releaseDate?.slice?.(0, 4) ?? context.year,
      });
    }

    for (const value of Object.values(node)) walk(value, context);
  }

  walk(root);
  const movieKeys = new Set();
  return found.filter(movie => {
    const key = [
      getSkyShowtimeMovieId(movie) || movie.titleLong || movie.titleMedium || movie.title || 'movie',
      movie.year || '?',
    ].join('::');
    if (movieKeys.has(key)) return false;
    movieKeys.add(key);
    return true;
  });
}

function getSkyShowtimeFormat(episode) {
  const formats = episode?.formats;
  if (!formats || typeof formats !== 'object') return null;
  const candidates = [formats.HD, formats.UHDSDR, ...Object.values(formats)]
    .filter(format => format && typeof format === 'object');
  const directMarkerKeys = [
    'SOI', 'EOI', 'SOR', 'EOR', 'SOCR', 'EOCR', 'EOC',
    'startOfCredits', 'creditsStart', 'endOfCredits', 'creditsEnd',
  ];
  const hasMarkers = format =>
    Boolean(format.markers && typeof format.markers === 'object' && Object.keys(format.markers).length) ||
    directMarkerKeys.some(key => format[key] != null);
  return candidates.find(hasMarkers) || candidates[0] || null;
}

function firstSkyShowtimeMarkerValue(markers, format, keys) {
  for (const key of keys) {
    const value = coerceSkyShowtimeNumber(markers?.[key] ?? format?.[key]);
    if (value != null) return value;
  }
  return null;
}

function getSkyShowtimeMovieCreditRange(movie, format) {
  const markers = format?.markers || {};
  const startMs = firstSkyShowtimeMarkerValue(markers, format, [
    'SOCR',
    'startOfCredits',
    'creditsStart',
    'creditsStartMs',
  ]);
  let endMs = firstSkyShowtimeMarkerValue(markers, format, [
    'EOCR',
    'EOC',
    'endOfCredits',
    'creditsEnd',
    'creditsEndMs',
  ]);
  const afterCreditsStartMs = firstSkyShowtimeMarkerValue(markers, format, [
    'SOAC',
    'SOAfterCredits',
    'afterCreditsStart',
    'afterCreditsStartMs',
    'postCreditsStart',
    'postCreditsStartMs',
  ]);
  const afterCreditsEndMs = firstSkyShowtimeMarkerValue(markers, format, [
    'EOAC',
    'EOAfterCredits',
    'afterCreditsEnd',
    'afterCreditsEndMs',
    'postCreditsEnd',
    'postCreditsEndMs',
  ]);
  const afterCreditsDetected = afterCreditsStartMs != null || afterCreditsEndMs != null || [
    markers.afterCredits,
    markers.afterCreditsScene,
    markers.postCredits,
    markers.postCreditsScene,
    format?.afterCredits,
    format?.afterCreditsScene,
    format?.postCredits,
    format?.postCreditsScene,
  ].some(value => value === true || (value && typeof value === 'object'));

  const durationMilliseconds = [
    movie.durationMilliseconds,
    movie.durationMs,
    format?.durationMilliseconds,
    format?.durationMs,
  ].map(coerceSkyShowtimeNumber).find(value => value != null) ?? null;
  const durationSeconds = [
    movie.durationSeconds,
    movie.runtimeSeconds,
    format?.durationSeconds,
    format?.runtimeSeconds,
  ].map(coerceSkyShowtimeNumber).find(value => value != null) ?? null;
  const durationMs = durationMilliseconds ?? (durationSeconds == null ? null : durationSeconds * 1000);
  if (endMs == null && afterCreditsStartMs != null) endMs = afterCreditsStartMs;
  if (endMs == null) endMs = durationMs;
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  if (durationMs != null) {
    if (startMs >= durationMs) return null;
    endMs = Math.min(endMs, durationMs);
  }
  if (endMs <= startMs) return null;
  return { startMs, endMs, afterCreditsStartMs, afterCreditsEndMs, afterCreditsDetected };
}

function isSkyShowtimeSpecialEpisode(episode) {
  if (Number(episode.seasonNumber) === 0 || episode.isSpecial === true) return true;
  const type = String(episode.type || episode.episodeType || '').trim().toLowerCase();
  return ['special', 'specials', 'bonus', 'extra', 'extras', 'trailer', 'trailers'].includes(type);
}

function makeSkyShowtimeEpisodeId(episode, season, episodeNumber) {
  const seriesId = episode.providerSeriesId || episode.seriesId || episode.seriesUuid || 'series';
  const variantId = episode.providerVariantId || episode.programmeUuid || episode.id || episode.episodeName || 'variant';
  return `${seriesId}::S${season}E${episodeNumber}::${variantId}`;
}

function addSkyShowtimeSegment(extractedItems, common, providerSegmentType, startMs, endMs, mediaType = 'tv', creditPart = null) {
  if (startMs == null || endMs == null || endMs <= startMs) return;
  const isMovie = String(mediaType).toLowerCase() === 'movie';
  const partSuffix = creditPart ? `::${creditPart}` : '';
  const episodeId = `${common.episodeId}${isMovie ? '::movie' : ''}::${providerSegmentType}${partSuffix}`;
  const isDuplicate = item => item._eid === episodeId || (
    item._showId === common.showId &&
    String(item.media_type || 'tv').toLowerCase() === String(mediaType).toLowerCase() &&
    item.season === common.season &&
    item.episode === common.episode &&
    item.segment_type === providerSegmentType &&
    (item.credit_part || null) === (creditPart || null)
  );
  if (state.allItems.some(isDuplicate) || extractedItems.some(isDuplicate)) return;
  extractedItems.push({
    _eid: episodeId,
    _episodeTitle: common.episodeTitle,
    _showId: common.showId,
    ...(isMovie ? { media_type: 'movie' } : {}),
    ...(creditPart ? { credit_part: creditPart } : {}),
    imdb_id: state.imdbIdsByShowId?.[common.showId] || 'IMDB_PENDING',
    segment_type: providerSegmentType,
    season: common.season,
    episode: common.episode,
    start_sec: roundSkyShowtimeSeconds(startMs / 1000),
    end_sec: roundSkyShowtimeSeconds(endMs / 1000),
  });
}

/** Parse SOI/EOI, SOR/EOR and SOCR/runtime markers from a catalogue response. */
export function processSkyShowtimeMetadata(data, sourceUrl = '') {
  const episodes = findSkyShowtimeEpisodes(data);
  const discoveredMovies = findSkyShowtimeMovies(data);
  const requestedVariantId = getSkyShowtimeRequestedVariantId(sourceUrl);
  const movies = requestedVariantId
    ? discoveredMovies.filter(movie => getSkyShowtimeMovieIdentifiers(movie).some(id => id === requestedVariantId))
    : discoveredMovies;
  if (!episodes.length && !movies.length) return 0;

  const showEpisode = episodes.find(episode => episode.seriesName || episode.titleLong || episode.titleMedium || episode.title);
  const showId = showEpisode
    ? showEpisode.providerSeriesId || showEpisode.seriesId || showEpisode.seriesUuid || null
    : null;
  const showTitle = showEpisode
    ? showEpisode.seriesName || showEpisode.titleLong || showEpisode.titleMedium || showEpisode.title
    : '';
  if (showEpisode) {
    handleDetectedShow({
      title: showTitle,
      showId,
      year: showEpisode.year || '',
    });
  }

  for (const movie of movies) {
    const movieId = getSkyShowtimeMovieId(movie) || movie.titleLong || movie.titleMedium || movie.title;
    const movieTitle = movie.titleLong || movie.titleMedium || movie.movieName || movie.title || movie.name || '';
    if (!movieId || !movieTitle) continue;
    handleDetectedShow({
      title: movieTitle,
      showId: String(movieId),
      year: movie.year || '',
      mediaType: 'movie',
    });
  }

  if (episodes.length) setProviderEpisodeCatalog(episodes.flatMap(episode => {
    const season = coerceSkyShowtimeNumber(episode.seasonNumber);
    const episodeNumber = coerceSkyShowtimeNumber(episode.episodeNumber);
    if (season == null || episodeNumber == null) return [];
    return [{
      providerId: episode.providerVariantId || episode.programmeUuid || episode.id || makeSkyShowtimeEpisodeId(episode, season, episodeNumber),
      season,
      episode: episodeNumber,
      title: episode.episodeName || episode.titleLong || episode.titleMedium || episode.title || '',
      isSpecial: isSkyShowtimeSpecialEpisode(episode),
    }];
  }), showId);

  const extractedItems = [];
  for (const episode of episodes) {
    const season = coerceSkyShowtimeNumber(episode.seasonNumber);
    const episodeNumber = coerceSkyShowtimeNumber(episode.episodeNumber);
    const durationMilliseconds = coerceSkyShowtimeNumber(episode.durationMilliseconds);
    const durationSeconds = coerceSkyShowtimeNumber(episode.durationSeconds);
    const durationMs = durationMilliseconds ?? (durationSeconds == null ? null : durationSeconds * 1000);
    const format = getSkyShowtimeFormat(episode);
    const markers = format?.markers || {};
    if (season == null || episodeNumber == null || !format) continue;

    const common = {
      episodeId: makeSkyShowtimeEpisodeId(episode, season, episodeNumber),
      episodeTitle: episode.episodeName || episode.titleLong || episode.titleMedium || episode.title || '',
      showId: episode.providerSeriesId || episode.seriesId || episode.seriesUuid || showId || 'unknown-series',
      season,
      episode: episodeNumber,
    };
    const episodeItems = [];
    addSkyShowtimeSegment(
      episodeItems,
      common,
      'recap',
      coerceSkyShowtimeNumber(markers.SOR),
      coerceSkyShowtimeNumber(markers.EOR)
    );
    addSkyShowtimeSegment(
      episodeItems,
      common,
      'intro',
      coerceSkyShowtimeNumber(markers.SOI),
      coerceSkyShowtimeNumber(markers.EOI)
    );
    addSkyShowtimeSegment(
      episodeItems,
      common,
      'outro',
      coerceSkyShowtimeNumber(markers.SOCR) ?? coerceSkyShowtimeNumber(format.startOfCredits),
      durationMs
    );
    extractedItems.push(...episodeItems);
    logCapturedTimestamps({
      prefix: 'SSE',
      showTitle: episode.seriesName || showTitle || state.showTitle,
      season,
      episode: episodeNumber,
      episodeTitle: common.episodeTitle,
      providerIdLabel: 'providerVariantId',
      providerId: episode.providerVariantId || episode.programmeUuid || episode.id || common.episodeId,
      items: episodeItems,
    });
  }

  for (const movie of movies) {
    const movieId = getSkyShowtimeMovieId(movie) || movie.titleLong || movie.titleMedium || movie.title;
    const movieTitle = movie.titleLong || movie.titleMedium || movie.movieName || movie.title || movie.name || '';
    const format = getSkyShowtimeFormat(movie);
    const creditRange = getSkyShowtimeMovieCreditRange(movie, format);
    if (!movieId || !movieTitle || !creditRange) continue;

    const common = {
      episodeId: String(movieId),
      episodeTitle: movieTitle,
      showId: String(movieId),
      season: null,
      episode: null,
    };
    const movieItems = [];
    const ranges = splitCreditRange({
      startSec: creditRange.startMs / 1000,
      endSec: creditRange.endMs / 1000,
      afterCreditsDetected: creditRange.afterCreditsDetected,
      afterCreditsStartSec: creditRange.afterCreditsStartMs == null ? null : creditRange.afterCreditsStartMs / 1000,
      afterCreditsEndSec: creditRange.afterCreditsEndMs == null ? null : creditRange.afterCreditsEndMs / 1000,
    });
    for (const range of ranges) {
      addSkyShowtimeSegment(
        movieItems,
        common,
        'outro',
        range.startSec * 1000,
        range.endSec * 1000,
        'movie',
        range.creditPart
      );
    }
    extractedItems.push(...movieItems);
    logCapturedTimestamps({
      prefix: 'SSE',
      showTitle: movieTitle,
      mediaType: 'movie',
      episodeTitle: movieTitle,
      providerIdLabel: 'providerVariantId',
      providerId: movieId,
      items: movieItems,
    });
  }

  if (extractedItems.length) {
    recordExtractedSegments(extractedItems);
    console.info(`[SSE] Captured ${extractedItems.length} segment(s) from ${sourceUrl || 'SkyShowtime metadata'}.`);
  }
  return extractedItems.length;
}

function getSkyShowtimeRequestUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function getGmRequest() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) ||
    (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
    (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

function buildSkyShowtimeWorkerSource(originalUrl, isModule) {
  const targetHost = JSON.stringify(SKYSHOWTIME_CATALOGUE_HOST);
  const targetPath = JSON.stringify(SKYSHOWTIME_CATALOGUE_PATH);
  const seriesPath = JSON.stringify(SKYSHOWTIME_SERIES_PATH);
  const variantPath = JSON.stringify(SKYSHOWTIME_VARIANT_PATH);
  const messageKey = JSON.stringify(SKYSHOWTIME_WORKER_MESSAGE);
  const importStatement = isModule
    ? `import(${JSON.stringify(originalUrl)});`
    : `importScripts(${JSON.stringify(originalUrl)});`;
  return `
    (() => {
      const messageKey = ${messageKey};
      const isTarget = url => {
        const value = String(url || '');
        return value.includes(${targetHost}) && value.includes(${targetPath}) &&
          (value.includes(${seriesPath}) || value.includes(${variantPath}));
      };
      const sendResponse = (response, url, via) => {
        response.clone().json().then(data => {
          self.postMessage({ [messageKey]: true, type: 'metadata', url, via, data });
        }).catch(() => {});
      };
      if (typeof self.fetch === 'function') {
        const originalFetch = self.fetch.bind(self);
        self.fetch = async function(input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const response = await originalFetch(input, init);
          if (isTarget(url)) sendResponse(response, url, 'worker-fetch');
          return response;
        };
      }
      if (typeof self.XMLHttpRequest === 'function') {
        const originalOpen = self.XMLHttpRequest.prototype.open;
        const originalSend = self.XMLHttpRequest.prototype.send;
        self.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__segmentScraperSkyUrl = url;
          return originalOpen.call(this, method, url, ...rest);
        };
        self.XMLHttpRequest.prototype.send = function(...args) {
          const url = this.__segmentScraperSkyUrl;
          if (isTarget(url)) {
            this.addEventListener('load', () => {
              try {
                const data = JSON.parse(this.responseText);
                self.postMessage({ [messageKey]: true, type: 'metadata', url, via: 'worker-xhr', data });
              } catch (_) {}
            });
          }
          return originalSend.apply(this, args);
        };
      }
    })();
    ${importStatement}
  `;
}

function installSkyShowtimeWorkerBridge(win, onMetadata) {
  const OriginalWorker = win.Worker;
  if (typeof OriginalWorker !== 'function' || !win.Blob || !win.URL?.createObjectURL) return;

  function SkyShowtimeWorker(scriptUrl, options) {
    const args = options === undefined ? [scriptUrl] : [scriptUrl, options];
    let wrapperUrl = '';
    try {
      const originalUrl = new win.URL(String(scriptUrl), win.document.baseURI).href;
      const source = buildSkyShowtimeWorkerSource(originalUrl, options?.type === 'module');
      wrapperUrl = win.URL.createObjectURL(new win.Blob([source], { type: 'text/javascript' }));
      const workerArgs = options === undefined ? [wrapperUrl] : [wrapperUrl, options];
      const worker = Reflect.construct(OriginalWorker, workerArgs, OriginalWorker);
      worker.addEventListener('message', event => {
        const message = event.data;
        if (!message || message[SKYSHOWTIME_WORKER_MESSAGE] !== true) return;
        event.stopImmediatePropagation();
        if (message.type === 'metadata' && message.data) onMetadata(message.data, message.url || '', message.via || 'worker');
      }, true);
      setTimeout(() => win.URL.revokeObjectURL(wrapperUrl), 1000);
      return worker;
    } catch (error) {
      if (wrapperUrl) win.URL.revokeObjectURL(wrapperUrl);
      console.warn('[SSE] Worker bridge unavailable for one worker; using the original worker.', error);
      return Reflect.construct(OriginalWorker, args, OriginalWorker);
    }
  }

  Object.setPrototypeOf(SkyShowtimeWorker, OriginalWorker);
  SkyShowtimeWorker.prototype = OriginalWorker.prototype;
  win.Worker = SkyShowtimeWorker;
}

export function isSkyShowtimePlayerPage() {
  return location.pathname.includes('/watch/playback/') || Boolean(document.querySelector('video'));
}

export function setupSkyShowtimeInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const fetchedUrls = new Set();
  const inFlightUrls = new Set();
  const originalFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;

  const processCapturedMetadata = (data, url, via) => {
    if (url) {
      inFlightUrls.delete(url);
      fetchedUrls.add(url);
    }
    try {
      processSkyShowtimeMetadata(data, `${via}: ${url}`);
    } catch (error) {
      console.error('[SSE] Failed to process SkyShowtime catalogue metadata:', error);
    }
  };

  if (originalFetch) {
    win.fetch = function (input, init) {
      const url = getSkyShowtimeRequestUrl(input);
      if (!isSkyShowtimeCatalogueUrl(url)) return originalFetch(input, init);

      inFlightUrls.add(url);
      return originalFetch(input, init).then(response => {
        response.clone().json()
          .then(data => processCapturedMetadata(data, url, 'page-fetch'))
          .catch(error => {
            inFlightUrls.delete(url);
            console.warn('[SSE] Failed to read page fetch response:', error);
            refetchCatalogue(url);
          });
        return response;
      }, error => {
        inFlightUrls.delete(url);
        throw error;
      });
    };
  }

  const OriginalXHR = win.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    function SkyShowtimeInterceptedXHR() {
      const xhr = new OriginalXHR();
      let url = '';
      const originalOpen = xhr.open.bind(xhr);
      const originalSend = xhr.send.bind(xhr);
      xhr.open = function (method, requestUrl, ...rest) {
        url = String(requestUrl || '');
        return originalOpen(method, requestUrl, ...rest);
      };
      xhr.send = function (...args) {
        if (isSkyShowtimeCatalogueUrl(url)) {
          inFlightUrls.add(url);
          xhr.addEventListener('load', () => {
            try { processCapturedMetadata(JSON.parse(xhr.responseText), url, 'page-xhr'); }
            catch (error) {
              inFlightUrls.delete(url);
              console.warn('[SSE] Failed to read page XHR response:', error);
              refetchCatalogue(url);
            }
          });
        }
        return originalSend(...args);
      };
      return xhr;
    }
    Object.setPrototypeOf(SkyShowtimeInterceptedXHR, OriginalXHR);
    SkyShowtimeInterceptedXHR.prototype = OriginalXHR.prototype;
    win.XMLHttpRequest = SkyShowtimeInterceptedXHR;
  }

  installSkyShowtimeWorkerBridge(win, processCapturedMetadata);

  function refetchCatalogue(url) {
    if (!isSkyShowtimeCatalogueUrl(url) || fetchedUrls.has(url) || inFlightUrls.has(url)) return;
    fetchedUrls.add(url);
    const gmRequest = getGmRequest();
    if (gmRequest) {
      gmRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            fetchedUrls.delete(url);
            console.warn(`[SSE] Catalogue refetch returned HTTP ${response.status}.`);
            return;
          }
          try { processCapturedMetadata(JSON.parse(response.responseText), url, 'resource-refetch'); }
          catch (error) { console.warn('[SSE] Failed to parse catalogue refetch:', error); }
        },
        onerror: () => {
          fetchedUrls.delete(url);
          console.warn('[SSE] Catalogue refetch failed.');
        },
        ontimeout: () => {
          fetchedUrls.delete(url);
          console.warn('[SSE] Catalogue refetch timed out.');
        },
      });
      return;
    }
    if (originalFetch) {
      originalFetch(url, { credentials: 'include' })
        .then(response => response.json())
        .then(data => processCapturedMetadata(data, url, 'resource-refetch'))
        .catch(error => {
          fetchedUrls.delete(url);
          console.warn('[SSE] Catalogue refetch failed:', error);
        });
    }
  }

  const scanResourceEntries = entries => {
    for (const entry of entries || []) refetchCatalogue(entry?.name || '');
  };
  try { scanResourceEntries(win.performance?.getEntriesByType('resource')); } catch (_) {}
  if (typeof win.PerformanceObserver === 'function') {
    try {
      const observer = new win.PerformanceObserver(list => scanResourceEntries(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    } catch (error) {
      console.warn('[SSE] Resource observer unavailable:', error);
    }
  }
}
