/** Netflix-specific metadata interception and segment extraction. */

import { state } from '../../core/state.js';
import { createNormalizedSegment } from '../../normalization/segment-mapper.js';
import { setProviderEpisodeCatalog } from '../../core/tvdb.js';
import { handleDetectedShow, recordExtractedSegments } from '../bootstrap.js';

export const NETFLIX_TITLE_OVERRIDES = {
  '81748089': 'tt2431250',
};

function isNetflixSpecialSeason(season) {
  if (Number(season?.seq) === 0 || season?.isSpecial === true) return true;
  const specialTypes = new Set(['special', 'specials', 'supplemental', 'bonus', 'extras', 'trailer', 'trailers']);
  const type = String(season?.type || season?.seasonType || '').trim().toLowerCase();
  if (specialTypes.has(type)) return true;
  const label = String(season?.name || season?.shortName || season?.title || '').trim().toLowerCase();
  return /^(?:specials?|bonus|extras|trailers?\s*(?:&|and)\s*more)$/.test(label);
}

function isNetflixSpecialEpisode(season, episode) {
  if (isNetflixSpecialSeason(season) || episode?.isSpecial === true) return true;
  const type = String(episode?.type || episode?.episodeType || '').trim().toLowerCase();
  return ['special', 'supplemental', 'bonus', 'extra', 'trailer'].includes(type);
}

export function processNetflixMetadata(data) {
  const video = data.video;
  if (!video) return;

  const showId = video.id != null ? String(video.id) : null;
  const year = video.seasons?.[0]?.year || '';
  handleDetectedShow({
    title: video.title,
    showId,
    year,
    imdbOverride: showId ? NETFLIX_TITLE_OVERRIDES[showId] : null,
  });

  setProviderEpisodeCatalog((video.seasons || []).flatMap(season =>
    (season.episodes || []).map(episode => ({
      providerId: episode.episodeId || episode.id,
      season: season.seq,
      episode: episode.seq,
      title: episode.title || episode.name || '',
      isSpecial: isNetflixSpecialEpisode(season, episode),
    }))
  ), showId);

  const extractedItems = [];
  for (const season of video.seasons || []) {
    for (const episode of season.episodes || []) {
      const episodeId = episode.episodeId || episode.id;
      if (state.allItems.some(item => item._eid === episodeId) || extractedItems.some(item => item._eid === episodeId)) continue;

      const common = {
        providerName: 'netflix',
        episodeId,
        showId,
        season: season.seq,
        episode: episode.seq,
        imdbId: state.imdbIdsByShowId?.[showId] || 'IMDB_PENDING',
        episodeTitle: episode.title || episode.name || '',
      };
      const markers = episode.skipMarkers || {};
      const segments = [
        markers.recap?.end > 0 && {
          providerSegmentType: 'recap',
          startSec: markers.recap.start / 1000,
          endSec: markers.recap.end / 1000,
        },
        markers.credit?.end > 0 && {
          providerSegmentType: 'credit',
          startSec: markers.credit.start / 1000,
          endSec: markers.credit.end / 1000,
        },
        markers.intro?.end > 0 && {
          providerSegmentType: 'intro',
          startSec: markers.intro.start / 1000,
          endSec: markers.intro.end / 1000,
        },
        episode.creditsOffset && episode.runtime && {
          providerSegmentType: 'creditsOffset',
          startSec: parseFloat(episode.creditsOffset),
          endSec: parseFloat(episode.runtime),
        },
      ].filter(Boolean);

      for (const segment of segments) {
        const item = createNormalizedSegment({ ...common, ...segment });
        if (item) extractedItems.push(item);
      }
    }
  }
  recordExtractedSegments(extractedItems);
}

export function setupNetflixInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OriginalXHR = win.XMLHttpRequest;

  function NetflixInterceptedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    const originalOpen = xhr.open.bind(xhr);
    const originalSend = xhr.send.bind(xhr);
    xhr.open = function (method, requestUrl, ...rest) {
      url = requestUrl;
      return originalOpen(method, requestUrl, ...rest);
    };
    xhr.send = function (...args) {
      if (url && url.includes('memberapi') && url.includes('metadata')) {
        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data?.video) processNetflixMetadata(data);
          } catch (_) {}
        });
      }
      return originalSend(...args);
    };
    return xhr;
  }
  Object.setPrototypeOf(NetflixInterceptedXHR, OriginalXHR);
  NetflixInterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = NetflixInterceptedXHR;

  const originalFetch = win.fetch.bind(win);
  win.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const response = await originalFetch(input, init);
    if (url.includes('memberapi') && url.includes('metadata')) {
      try {
        const data = await response.clone().json();
        if (data?.video) processNetflixMetadata(data);
      } catch (_) {}
    }
    return response;
  };
}
