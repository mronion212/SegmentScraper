/** TVDB v4 authentication, local settings, and conservative episode mapping. */

import { state } from './state.js';

const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const TVDB_STORAGE = {
  apiKey: 'segmentScraper.tvdb.apikey',
  pin: 'segmentScraper.tvdb.pin',
  token: 'segmentScraper.tvdb.token',
  tokenCreatedAt: 'segmentScraper.tvdb.tokenCreatedAt',
};
const TOKEN_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
const TVDB_EPISODE_LANGUAGE = 'eng';
const TVDB_SEASON_TYPE = 'default';
const TVDB_EPISODE_ENDPOINT_SHAPE = `${TVDB_BASE}/series/{seriesId}/episodes/{seasonType}/{language}?page={page}`;
let loginPromise = null;
const episodeListCache = new Map();
const episodeTranslationCache = new Map();

function getStoredValue(key, fallback = '') {
  try {
    return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setStoredValue(key, value) {
  try {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  } catch (_) {}
}

function getGmXhr() {
  return (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null) ||
    (typeof _GM_xmlhttpRequest !== 'undefined' ? _GM_xmlhttpRequest : null) ||
    (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
}

function tvdbRequest({ method = 'GET', path, token = '', data }) {
  const url = `${TVDB_BASE}${path}`;
  const headers = { Accept: 'application/json' };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const gmXhr = getGmXhr();

  if (gmXhr) {
    return new Promise((resolve, reject) => {
      gmXhr({
        method,
        url,
        headers,
        data: data === undefined ? undefined : JSON.stringify(data),
        timeout: 15000,
        onload: response => {
          let body = null;
          try { body = response.responseText ? JSON.parse(response.responseText) : null; } catch (_) {}
          resolve({ status: response.status, body });
        },
        onerror: () => reject(new Error('TVDB network request failed')),
        ontimeout: () => reject(new Error('TVDB network request timed out')),
      });
    });
  }

  return fetch(url, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  }).then(async response => {
    let body = null;
    try { body = await response.json(); } catch (_) {}
    return { status: response.status, body };
  });
}

export function loadTvdbSettings() {
  state.tvdbApiKey = String(getStoredValue(TVDB_STORAGE.apiKey, '') || '');
  state.tvdbPin = String(getStoredValue(TVDB_STORAGE.pin, '') || '');
  return { apiKey: state.tvdbApiKey, pin: state.tvdbPin };
}

export function saveTvdbSettings(apiKey, pin = '') {
  const nextApiKey = String(apiKey || '').trim();
  const nextPin = String(pin || '').trim();
  const credentialsChanged = nextApiKey !== state.tvdbApiKey || nextPin !== state.tvdbPin;
  state.tvdbApiKey = nextApiKey;
  state.tvdbPin = nextPin;
  setStoredValue(TVDB_STORAGE.apiKey, nextApiKey);
  setStoredValue(TVDB_STORAGE.pin, nextPin);
  if (credentialsChanged) clearTvdbToken();
}

function clearTvdbToken() {
  setStoredValue(TVDB_STORAGE.token, '');
  setStoredValue(TVDB_STORAGE.tokenCreatedAt, 0);
}

async function loginTvdb() {
  if (!state.tvdbApiKey) throw new Error('No TVDB API key configured');
  const credentials = { apikey: state.tvdbApiKey };
  if (state.tvdbPin) credentials.pin = state.tvdbPin;
  const response = await tvdbRequest({ method: 'POST', path: '/login', data: credentials });
  const token = response.body?.data?.token;
  if (response.status < 200 || response.status >= 300 || !token) {
    throw new Error(`TVDB login failed (HTTP ${response.status || 0})`);
  }
  setStoredValue(TVDB_STORAGE.token, token);
  setStoredValue(TVDB_STORAGE.tokenCreatedAt, Date.now());
  return token;
}

async function getTvdbToken(forceRefresh = false) {
  const token = String(getStoredValue(TVDB_STORAGE.token, '') || '');
  const createdAt = Number(getStoredValue(TVDB_STORAGE.tokenCreatedAt, 0)) || 0;
  if (!forceRefresh && token && createdAt && Date.now() - createdAt < TOKEN_MAX_AGE_MS) return token;
  if (!loginPromise) loginPromise = loginTvdb().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function authenticatedTvdbGet(path) {
  let token = await getTvdbToken(false);
  let response = await tvdbRequest({ path, token });
  if (response.status === 401) {
    clearTvdbToken();
    token = await getTvdbToken(true);
    response = await tvdbRequest({ path, token });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`TVDB request failed (HTTP ${response.status || 0})`);
  }
  return response.body?.data;
}

function cachedTvdbGet(cache, key, path) {
  if (!cache.has(key)) {
    const request = authenticatedTvdbGet(path).catch(error => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, request);
  }
  return cache.get(key);
}

async function fetchTvdbEpisodeList(seriesId, language = TVDB_EPISODE_LANGUAGE) {
  const normalizedLanguage = String(language || TVDB_EPISODE_LANGUAGE).trim().toLowerCase();
  const encodedSeriesId = encodeURIComponent(seriesId);
  const encodedLanguage = encodeURIComponent(normalizedLanguage);
  const cacheKey = `series:${seriesId}|seasonType:${TVDB_SEASON_TYPE}|language:${normalizedLanguage}|page:0`;
  const path = `/series/${encodedSeriesId}/episodes/${TVDB_SEASON_TYPE}/${encodedLanguage}?page=0`;
  const data = await cachedTvdbGet(episodeListCache, cacheKey, path);
  return data?.series?.episodes || data?.episodes || [];
}

async function fetchTvdbEpisodeTranslation(episodeId, language = TVDB_EPISODE_LANGUAGE) {
  const normalizedLanguage = String(language || TVDB_EPISODE_LANGUAGE).trim().toLowerCase();
  const cacheKey = `episode:${episodeId}|language:${normalizedLanguage}`;
  const path = `/episodes/${encodeURIComponent(episodeId)}/translations/${encodeURIComponent(normalizedLanguage)}`;
  return cachedTvdbGet(episodeTranslationCache, cacheKey, path);
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isGenericEpisodeTitle(value) {
  const title = normalizeTitle(value);
  return /^(?:episode|aflevering|folge|episodio|episode|capitulo|chapter|part|deel)\s*(?:(?:no|number|nr)\s*)?\d+$/.test(title) ||
    /^(?:s\s*\d+\s*)?e\s*\d+$/.test(title);
}

function incrementReason(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function describeSkipReasons(reasons) {
  const labels = {
    genericTitle: 'generic titles',
    missingTitle: 'missing titles',
    duplicateProviderTitle: 'duplicate provider titles',
    noExactMatch: 'no exact normalized TVDB match',
    ambiguousTvdbTitle: 'ambiguous TVDB titles',
    reusedTvdbEpisode: 'TVDB episode already matched',
  };
  return Object.entries(reasons)
    .map(([reason, count]) => `${labels[reason] || reason}: ${count}`)
    .join(', ');
}

function normalizeProviderEpisodes(episodes) {
  const unique = new Map();
  for (const episode of episodes || []) {
    const season = Number(episode.season);
    const number = Number(episode.episode);
    if (!Number.isInteger(season) || !Number.isInteger(number) || season < 0 || number < 1) continue;
    const key = episode.providerId ? `id:${episode.providerId}` : `number:${season}:${number}`;
    if (!unique.has(key)) unique.set(key, {
      providerId: episode.providerId == null ? '' : String(episode.providerId),
      season,
      episode: number,
      title: String(episode.title || '').trim(),
      isSpecial: season === 0 || episode.isSpecial === true,
    });
  }
  return [...unique.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function getDeclaredEpisodeNameLanguage(episode) {
  return String(episode?.nameLanguage || episode?.language || '').trim().toLowerCase();
}

function summarizeEpisodeNameLanguages(episodes) {
  const counts = {};
  for (const episode of episodes) {
    const language = episode._nameLanguage || 'unknown';
    counts[language] = (counts[language] || 0) + 1;
  }
  return counts;
}

async function ensureTvdbEpisodeNameLanguage(episodes, providerEpisodes, language) {
  const providerTitlesByNumber = new Map(providerEpisodes
    .map(episode => [`${episode.season}|${episode.episode}`, normalizeTitle(episode.title)])
    .filter(([, title]) => title));
  return Promise.all((episodes || []).map(async episode => {
    const returnedTitle = normalizeTitle(episode?.name);
    const declaredLanguage = getDeclaredEpisodeNameLanguage(episode);
    const correspondingProviderTitle = providerTitlesByNumber.get(`${episode?.seasonNumber}|${episode?.number}`);
    const contradictsEnglishProviderTitle = language === 'eng' && correspondingProviderTitle &&
      returnedTitle !== correspondingProviderTitle;
    const returnedLanguage = declaredLanguage || language;
    const needsExplicitTranslation = episode?.id != null && (
      !returnedTitle ||
      (declaredLanguage && declaredLanguage !== language) ||
      contradictsEnglishProviderTitle
    );

    if (!needsExplicitTranslation) return { ...episode, _nameLanguage: returnedLanguage };

    try {
      const translation = await fetchTvdbEpisodeTranslation(episode.id, language);
      const translatedName = String(translation?.name || '').trim();
      if (translatedName) {
        return {
          ...episode,
          name: translatedName,
          _nameLanguage: String(translation?.language || language).trim().toLowerCase(),
        };
      }
    } catch (error) {
      console.warn('[TVDB] Explicit episode translation request failed', {
        episodeId: episode.id,
        requestedLanguage: language,
        endpointUrlShape: `${TVDB_BASE}/episodes/{episodeId}/translations/{language}`,
        reason: error?.message || String(error),
      });
    }
    return { ...episode, _nameLanguage: returnedLanguage };
  }));
}

function logTvdbEpisodeLanguageAudit(seriesId, language, episodes) {
  console.info('[TVDB] Series episode language audit', {
    seriesId: String(seriesId),
    requestedLanguage: language,
    endpointUrlShape: TVDB_EPISODE_ENDPOINT_SHAPE,
    returnedEpisodeNameLanguages: summarizeEpisodeNameLanguages(episodes),
  });
}

function cleanTvdbEpisodes(episodes) {
  const unique = new Map();
  let specialsExcluded = 0;
  for (const episode of episodes || []) {
    const season = Number(episode.seasonNumber);
    const number = Number(episode.number);
    if (season === 0) {
      specialsExcluded++;
      continue;
    }
    if (!Number.isInteger(season) || !Number.isInteger(number) || season < 1 || number < 1 || episode.id == null) continue;
    if (!unique.has(String(episode.id))) unique.set(String(episode.id), {
      id: episode.id,
      season,
      episode: number,
      title: String(episode.name || '').trim(),
    });
  }
  return {
    episodes: [...unique.values()].sort((a, b) => a.season - b.season || a.episode - b.episode),
    specialsExcluded,
  };
}

function findDuplicateNumber(episodes) {
  const seen = new Set();
  for (const episode of episodes) {
    const key = `${episode.season}|${episode.episode}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

function mapEpisodes(providerEpisodes, tvdbEpisodes) {
  const mapping = new Map();
  if (providerEpisodes.length === tvdbEpisodes.length) {
    providerEpisodes.forEach((episode, index) => mapping.set(`${episode.season}|${episode.episode}`, tvdbEpisodes[index]));
    return {
      success: true,
      mapping,
      method: 'order',
      reason: 'regular-episode counts match',
      matchStats: { matched: providerEpisodes.length, skipped: 0, skipReasons: {} },
    };
  }

  const providerTitleCounts = new Map();
  for (const episode of providerEpisodes) {
    const title = normalizeTitle(episode.title);
    if (title) providerTitleCounts.set(title, (providerTitleCounts.get(title) || 0) + 1);
  }

  const tvdbByTitle = new Map();
  for (const episode of tvdbEpisodes) {
    const title = normalizeTitle(episode.title);
    if (!title) continue;
    if (!tvdbByTitle.has(title)) tvdbByTitle.set(title, []);
    tvdbByTitle.get(title).push(episode);
  }

  const skipReasons = {};
  const usedTvdbIds = new Set();
  for (const providerEpisode of providerEpisodes) {
    const title = normalizeTitle(providerEpisode.title);
    if (!title) {
      incrementReason(skipReasons, 'missingTitle');
      continue;
    }
    if (isGenericEpisodeTitle(title)) {
      incrementReason(skipReasons, 'genericTitle');
      continue;
    }
    if (providerTitleCounts.get(title) !== 1) {
      incrementReason(skipReasons, 'duplicateProviderTitle');
      continue;
    }

    const exact = tvdbByTitle.get(title) || [];
    if (!exact.length) {
      incrementReason(skipReasons, 'noExactMatch');
      continue;
    }
    if (exact.length !== 1) {
      incrementReason(skipReasons, 'ambiguousTvdbTitle');
      continue;
    }

    const match = exact[0];
    if (usedTvdbIds.has(String(match.id))) {
      incrementReason(skipReasons, 'reusedTvdbEpisode');
      continue;
    }
    usedTvdbIds.add(String(match.id));
    mapping.set(`${providerEpisode.season}|${providerEpisode.episode}`, match);
  }

  const matchStats = {
    matched: mapping.size,
    skipped: providerEpisodes.length - mapping.size,
    skipReasons,
  };
  const reasonSummary = describeSkipReasons(skipReasons);
  if (!mapping.size) {
    return {
      success: false,
      mapping,
      method: 'title',
      reason: `regular-episode counts differ and no reliable exact title mappings exist${reasonSummary ? ` (${reasonSummary})` : ''}`,
      matchStats,
    };
  }
  return {
    success: true,
    mapping,
    method: 'title',
    reason: `regular-episode counts differ; ${mapping.size} matched and ${matchStats.skipped} skipped${reasonSummary ? ` (${reasonSummary})` : ''}`,
    matchStats,
  };
}

async function resolveTvdbSeriesId(imdbId) {
  const results = await authenticatedTvdbGet(`/search/remoteid/${encodeURIComponent(imdbId)}`);
  const ids = [...new Set((Array.isArray(results) ? results : [])
    .map(result => result?.series?.id)
    .filter(id => id != null)
    .map(String))];
  if (!ids.length) throw new Error('no TVDB series matched the IMDb ID');
  if (ids.length !== 1) throw new Error('the IMDb ID matched multiple TVDB series');
  return ids[0];
}

/**
 * Return export/submission-safe items whose season/episode metadata is canonical TVDB data.
 * Count mismatches may return a partial, reliable title mapping. A failure means
 * that no regular provider episode could be mapped safely for the series.
 */
export async function mapSeriesItemsToTvdb(items, providerCatalog) {
  if (!items.length) return { success: true, items: [], method: 'none' };
  const imdbId = items[0].imdb_id;
  const catalog = normalizeProviderEpisodes(providerCatalog);
  const providerSpecialKeys = new Set(catalog
    .filter(episode => episode.isSpecial)
    .map(episode => `${episode.season}|${episode.episode}`));
  const regularItems = items.filter(item => {
    const season = Number(item.season);
    return Number.isInteger(season) && season > 0 && !providerSpecialKeys.has(`${item.season}|${item.episode}`);
  });
  const capturedSpecialsExcluded = items.length - regularItems.length;
  if (!regularItems.length) {
    const providerSpecialsExcluded = catalog.filter(episode => episode.isSpecial).length;
    return {
      success: true,
      items: [],
      method: 'specials-only',
      reason: 'all captured segments belong to provider specials',
      stats: { providerRegular: 0, tvdbRegular: 0, providerSpecialsExcluded, tvdbSpecialsExcluded: 0, capturedSpecialsExcluded },
    };
  }

  const providerEpisodes = catalog.filter(episode => !episode.isSpecial);
  const providerSpecialsExcluded = catalog.length - providerEpisodes.length;
  if (!providerEpisodes.length) {
    return { success: false, reason: 'provider regular-episode metadata is unavailable' };
  }
  const duplicateProviderNumber = findDuplicateNumber(providerEpisodes);
  if (duplicateProviderNumber) {
    return { success: false, reason: `provider metadata has duplicate regular episode number ${duplicateProviderNumber.replace('|', 'x')}` };
  }
  try {
    const tvdbSeriesId = await resolveTvdbSeriesId(imdbId);
    const episodeList = await fetchTvdbEpisodeList(tvdbSeriesId, TVDB_EPISODE_LANGUAGE);
    const localizedEpisodes = await ensureTvdbEpisodeNameLanguage(episodeList, providerEpisodes, TVDB_EPISODE_LANGUAGE);
    logTvdbEpisodeLanguageAudit(tvdbSeriesId, TVDB_EPISODE_LANGUAGE, localizedEpisodes);
    const tvdbCatalog = cleanTvdbEpisodes(localizedEpisodes);
    const tvdbEpisodes = tvdbCatalog.episodes;
    if (!tvdbEpisodes.length) return { success: false, reason: 'TVDB returned no usable episode metadata' };
    const duplicateTvdbNumber = findDuplicateNumber(tvdbEpisodes);
    if (duplicateTvdbNumber) {
      return { success: false, reason: `TVDB metadata has duplicate regular episode number ${duplicateTvdbNumber.replace('|', 'x')}` };
    }
    const result = mapEpisodes(providerEpisodes, tvdbEpisodes);
    const stats = {
      providerRegular: providerEpisodes.length,
      tvdbRegular: tvdbEpisodes.length,
      providerSpecialsExcluded,
      tvdbSpecialsExcluded: tvdbCatalog.specialsExcluded,
      capturedSpecialsExcluded,
      regularEpisodesMatched: result.matchStats?.matched ?? 0,
      regularEpisodesSkipped: result.matchStats?.skipped ?? providerEpisodes.length,
      regularEpisodeSkipReasons: result.matchStats?.skipReasons || {},
    };
    if (!result.success) return { ...result, stats };

    const mappedItems = [];
    for (const item of regularItems) {
      const match = result.mapping.get(`${item.season}|${item.episode}`);
      if (!match) continue;
      const { _eid, _episodeTitle, ...submissionItem } = item;
      mappedItems.push({ ...submissionItem, season: match.season, episode: match.episode });
    }
    stats.capturedRegularSegmentsMatched = mappedItems.length;
    stats.capturedRegularSegmentsSkipped = regularItems.length - mappedItems.length;
    return { success: true, items: mappedItems, method: result.method, reason: result.reason, tvdbSeriesId, stats };
  } catch (error) {
    return { success: false, reason: error?.message || 'TVDB mapping failed' };
  }
}

export function setProviderEpisodeCatalog(episodes) {
  state.providerEpisodes = normalizeProviderEpisodes(episodes);
}

export function recordProviderEpisode(episode) {
  const current = normalizeProviderEpisodes([...(state.providerEpisodes || []), episode]);
  state.providerEpisodes = current;
}
