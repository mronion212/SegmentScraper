/**
 * Shared provider bootstrap and control flow.
 * The Netflix UI/controls are the single source of truth for every provider.
 */

import { state, createState, createMediaCacheKey } from '../core/state.js';
import { checkForRequiredUpdate } from '../core/update-check.js';
import { searchImdbByTitle, lookupImdbTitle, loadExistingSegments, loadExistingSegmentsForEpisode, submitSegment } from '../core/network.js';
import { injectBtn, getNextEpBtn } from '../ui/button.js';
import { setProviderName, closePanel, updateCounters, updatePanelTitle, toast, updateImdbInput, showExportPreview, showRequiredUpdate } from '../ui/panel.js';
import { getProviderConfig } from '../config/provider-config.js';
import { loadIntrodbSettings, saveIntrodbSettings } from '../core/introdb-settings.js';
import { checkTmdbExtraScenes, saveTmdbToken } from '../core/tmdb.js';
import { loadTvdbSettings, saveTvdbSettings, mapSeriesItemsToTvdb } from '../core/tvdb.js';

const BUTTON_IDLE_DELAY_MS = 3000;
let activeProviderConfig = getProviderConfig('netflix');
let buttonHideTimer;

function getItemShowId(item) {
  return item?._showId != null ? String(item._showId) : '';
}

function getItemMediaType(item) {
  return String(item?.media_type || item?.mediaType || item?._mediaType || 'tv').toLowerCase() === 'movie'
    ? 'movie'
    : 'tv';
}

function isMovieItem(item) {
  return getItemMediaType(item) === 'movie';
}

function getItemCacheKey(item) {
  return createMediaCacheKey(item.imdb_id, getItemMediaType(item), item.season, item.episode);
}

function hasTvItems(items) {
  return items.some(item => !isMovieItem(item));
}

function hasExistingSegment(existing, item) {
  if (!existing) return false;
  const ranges = existing.rangesByType?.get(item.segment_type);
  if (ranges?.length) {
    const start = Number(item.start_sec);
    const end = Number(item.end_sec);
    return ranges.some(range => {
      const sameRange = Number.isFinite(start) && Number.isFinite(end) &&
        Math.abs(Number(range.startSec) - start) < 0.01 &&
        Math.abs(Number(range.endSec) - end) < 0.01;
      if (!sameRange) return false;
      return !item.credit_part || !range.creditPart || item.credit_part === range.creditPart;
    });
  }
  return existing.has?.(item.segment_type) ?? false;
}

// Temporary policy: exclude the entire movie when an extra scene is known.
// Missing provider/IntroDB markers are unknown, not evidence of scene absence.
async function filterMoviesWithKnownExtraScenes(items, existingByKey) {
  const excluded = new Set();
  for (const item of [...state.allItems, ...items]) {
    if (isMovieItem(item) && item.segment_type === 'post-credits') excluded.add(getItemCacheKey(item));
  }
  for (const item of items) {
    if (!isMovieItem(item)) continue;
    const key = getItemCacheKey(item);
    const existing = existingByKey.get(key);
    if (existing?.has?.('post-credits') || existing?.rangesByType?.get('post-credits')?.length) excluded.add(key);
  }
  const movieIds = [...new Set(items.filter(isMovieItem).filter(item => !excluded.has(getItemCacheKey(item))).map(item => item.imdb_id))];
  const tmdbResults = new Map();
  if (movieIds.length) toast(`Checking TMDB for extra scenes (${movieIds.length} movie(s))...`);
  for (const id of movieIds) tmdbResults.set(id, await checkTmdbExtraScenes(id));
  const notified = new Set();
  return items.filter(item => {
    if (!isMovieItem(item)) return true;
    const key = getItemCacheKey(item);
    const tmdb = tmdbResults.get(item.imdb_id);
    const knownScene = excluded.has(key) || tmdb?.status === 'present';
    if (!knownScene && tmdb?.status === 'unknown') return true;
    if (!notified.has(key)) {
      toast(knownScene
        ? `Movie ${item.imdb_id}: extra scene detected${tmdb?.status === 'present' ? ' by TMDB' : ''}; entire movie temporarily excluded.`
        : `Movie ${item.imdb_id}: ${tmdb?.reason || 'TMDB check unavailable'}; export and upload withheld.`);
      notified.add(key);
    }
    return false;
  });
}

function applyImdbIdToShow(imdbId, showId, { overwrite = false } = {}) {
  const normalizedShowId = showId != null ? String(showId) : '';
  const hasTaggedItems = state.allItems.some(item => getItemShowId(item));
  state.allItems.forEach(item => {
    const belongsToShow = normalizedShowId
      ? getItemShowId(item) === normalizedShowId || (!hasTaggedItems && !getItemShowId(item))
      : !getItemShowId(item);
    const canUpdate = overwrite || !item.imdb_id || item.imdb_id === 'IMDB_PENDING';
    if (belongsToShow && canUpdate) item.imdb_id = imdbId;
  });
  if (normalizedShowId) {
    state.imdbIdsByShowId ||= {};
    state.imdbIdsByShowId[normalizedShowId] = imdbId;
  }
}

export function setDbStatus(msg) {
  state.dbStatusMsg = msg;
  const el = document.getElementById('nfe-imdb-status');
  if (el) el.textContent = `${state.mediaType === 'movie' ? 'Movie' : 'TV'} · IMDb ID: ${state.imdbId || 'Not set'}`;
}

export function setIntrodbStatus(msg) {
  const el = document.getElementById('nfe-introdb-status');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

export function setTvdbStatus(msg) {
  const el = document.getElementById('nfe-tvdb-status');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

/** Apply the shared IMDb flow after an extractor discovers a show. */
export function handleDetectedShow({ title, showId = null, year = '', imdbOverride = null, mediaType = 'tv' }) {
  if (state.updateRequired) return;
  const normalizedShowId = showId != null ? String(showId) : null;
  const normalizedMediaType = String(mediaType).toLowerCase() === 'movie' ? 'movie' : 'tv';
  const showChanged = Boolean(title) && (
    title !== state.showTitle ||
    (normalizedShowId && normalizedShowId !== state.showId) ||
    normalizedMediaType !== (state.mediaType || 'tv')
  );
  if (showChanged) {
    state.showTitle = title;
    state.mediaType = normalizedMediaType;
    state.showId = normalizedShowId;
    if (state.showId) state.showIds.add(state.showId);
    state.showYear = year ? String(year) : '';
    state.dbSearchDone = false;
    state.imdbId = '';
    state.dedupCacheV2 = {};
    state.providerEpisodes = [];
    updateImdbInput();
    setDbStatus(`Detected ${normalizedMediaType === 'movie' ? 'movie' : 'TV series'}; looking up IMDb...`);
    setTvdbStatus(normalizedMediaType === 'movie'
      ? 'TVDB is not needed for movies'
      : (state.tvdbApiKey ? 'TVDB credentials saved locally' : ''));
    updatePanelTitle();
  }

  if (state.dbSearchDone || !state.showTitle) return;
  state.dbSearchDone = true;

  const lookupTitle = state.showTitle;
  const lookupYear = state.showYear;
  const lookupShowId = state.showId;
  const lookupMediaType = state.mediaType || 'tv';
  const isCurrentShow = () => lookupShowId
    ? state.showId === lookupShowId && (state.mediaType || 'tv') === lookupMediaType
    : state.showTitle === lookupTitle && (state.mediaType || 'tv') === lookupMediaType;

  const cachedImdbId = lookupShowId && state.imdbIdsByShowId?.[lookupShowId];
  if (!imdbOverride && cachedImdbId) {
    state.imdbId = cachedImdbId;
    applyImdbIdToShow(cachedImdbId, lookupShowId);
    updateImdbInput();
    setDbStatus(`Found: ${cachedImdbId}`);
    updateCounters();
    return;
  }

  if (imdbOverride) {
    state.imdbId = imdbOverride;
    applyImdbIdToShow(imdbOverride, lookupShowId);
    updateImdbInput();
    setDbStatus(`Manual override applied · ID: ${imdbOverride}`);
    updateCounters();
    loadExistingSegments(imdbOverride);
    return;
  }

  searchImdbByTitle(lookupTitle, lookupYear, { mediaType: lookupMediaType }).then(result => {
    if (result.success) {
      console.info('[NFE] IMDb media resolved:', {
        mediaType: lookupMediaType,
        title: lookupTitle,
        imdbId: result.imdbId,
      });
      applyImdbIdToShow(result.imdbId, lookupShowId);
      if (!isCurrentShow()) return;
      state.imdbId = result.imdbId;
      updateImdbInput();
      setDbStatus(`Found: ${result.imdbId}`);
      updateCounters();
      loadExistingSegments(result.imdbId);
    } else {
      if (!isCurrentShow()) return;
      setDbStatus(`IMDb lookup failed: ${result.error}`);
    }
  }).catch(error => {
    console.error('[NFE] IMDb search error:', error);
    if (!isCurrentShow()) return;
    setDbStatus('IMDb lookup error');
  });
}

/** Store extractor output and update the shared counters/toast identically. */
export function recordExtractedSegments(items) {
  if (state.updateRequired) return;
  if (!items.length) return;
  state.allItems.push(...items);
  state.interceptedCount++;
  updateCounters();
  toast(`+${items.length} timestamps captured · total: ${state.allItems.length}`);
}

export function isAlreadyInIntroDB(item) {
  const key = getItemCacheKey(item);
  return hasExistingSegment(state.dedupCacheV2[key], item);
}

async function mapCapturedItemsWithTvdb(action) {
  const capturedItems = state.allItems.slice();
  const pendingItems = capturedItems.filter(item => !item.imdb_id || item.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length) {
    toast(`${pendingItems.length} timestamp(s) without an IMDb ID will be skipped from ${action}.`);
  }

  const validItems = capturedItems.filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING');
  const movieItems = validItems.filter(isMovieItem);
  const seriesGroups = new Map();
  for (const item of validItems.filter(item => !isMovieItem(item))) {
    if (!seriesGroups.has(item.imdb_id)) seriesGroups.set(item.imdb_id, []);
    seriesGroups.get(item.imdb_id).push(item);
  }

  // Movies have no season/episode pair and deliberately bypass TVDB mapping.
  const items = movieItems.slice();
  let unreliableSkipped = 0;
  let specialSegmentsExcluded = 0;
  const reasonLabels = {
    genericTitle: 'generic title',
    missingTitle: 'missing title',
    duplicateProviderTitle: 'duplicate provider title',
    noExactMatch: 'no exact normalized TVDB match',
    ambiguousTvdbTitle: 'ambiguous TVDB title',
    reusedTvdbEpisode: 'TVDB episode already matched',
    missingAbsoluteNumber: 'title without an absolute episode number',
    absoluteEpisodeNotFound: 'absolute TVDB episode not found',
    ambiguousAbsoluteEpisode: 'ambiguous absolute TVDB episode',
    invalidCanonicalEpisode: 'TVDB episode without canonical default numbering',
  };
  const describeReasons = reasons => Object.entries(reasons || {})
    .map(([reason, count]) => `${reasonLabels[reason] || reason}: ${count}`)
    .join(', ') || 'none';
  for (const [imdbId, seriesItems] of seriesGroups) {
    const showId = getItemShowId(seriesItems[0]);
    const catalog = showId
      ? state.providerEpisodesByShowId?.[showId] || []
      : (imdbId === state.imdbId ? state.providerEpisodes : []);
    const mapped = await mapSeriesItemsToTvdb(seriesItems, catalog);
    const stats = mapped.stats;
    if (!mapped.success) {
      unreliableSkipped += seriesItems.length;
      const counts = stats ? ` Provider regular: ${stats.providerRegular}; TVDB regular: ${stats.tvdbRegular}; provider specials excluded: ${stats.providerSpecialsExcluded}; TVDB Season 0 excluded: ${stats.tvdbSpecialsExcluded}.` : '';
      const titleCounts = stats ? ` Regular episodes matched: ${stats.regularEpisodesMatched ?? 0}; skipped: ${stats.regularEpisodesSkipped ?? stats.providerRegular}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}.` : '';
      console.warn(`[NFE-TVDB] Skipping series ${imdbId} from ${action}: ${mapped.reason}.${counts}${titleCounts}`);
      continue;
    }

    specialSegmentsExcluded += stats?.capturedSpecialsExcluded || 0;
    unreliableSkipped += stats?.capturedRegularSegmentsSkipped || 0;
    if (mapped.method === 'order') {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: regular counts match (${stats.providerRegular}); mapped by TVDB order. Regular episodes matched: ${stats.regularEpisodesMatched}; skipped: ${stats.regularEpisodesSkipped}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}. Provider specials excluded: ${stats.providerSpecialsExcluded}; TVDB Season 0 excluded: ${stats.tvdbSpecialsExcluded}; captured regular segments omitted: ${stats.capturedRegularSegmentsSkipped}; captured special segments omitted: ${stats.capturedSpecialsExcluded}.`);
    } else if (mapped.method === 'title') {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: regular counts differ (provider ${stats.providerRegular}, TVDB ${stats.tvdbRegular}); retained reliable exact normalized one-to-one title mappings. Regular episodes matched: ${stats.regularEpisodesMatched}; skipped: ${stats.regularEpisodesSkipped}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}. Provider specials excluded: ${stats.providerSpecialsExcluded}; TVDB Season 0 excluded: ${stats.tvdbSpecialsExcluded}; captured regular segments omitted: ${stats.capturedRegularSegmentsSkipped}; captured special segments omitted: ${stats.capturedSpecialsExcluded}.`);
    } else if (mapped.method === 'absolute-title') {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: GTST episodes mapped by absolute episode number and verified by exact normalized TVDB title. Regular episodes matched: ${stats.regularEpisodesMatched}; skipped: ${stats.regularEpisodesSkipped}; reasons: ${describeReasons(stats.regularEpisodeSkipReasons)}; captured regular segments omitted: ${stats.capturedRegularSegmentsSkipped}.`);
    } else {
      console.info(`[NFE-TVDB] ${action} series ${imdbId}: no regular segments included (${mapped.reason}); captured special segments omitted: ${stats?.capturedSpecialsExcluded || 0}.`);
    }
    items.push(...mapped.items);
  }

  if (unreliableSkipped) {
    toast(`${unreliableSkipped} timestamp(s) skipped from ${action} because TVDB mapping was not reliable.`);
  }
  return {
    items,
    capturedItems,
    pendingSkipped: pendingItems.length,
    unreliableSkipped,
    specialSegmentsExcluded,
  };
}

const MIN_OUTPUT_SEGMENT_DURATION_SECONDS = 5;

function filterShortOutputSegments(items) {
  return items.filter(item => {
    const start = Number(item?.start_sec);
    const end = Number(item?.end_sec);
    return Number.isFinite(start)
      && Number.isFinite(end)
      && start >= 0
      && end - start >= MIN_OUTPUT_SEGMENT_DURATION_SECONDS
      && (!isMovieItem(item) || (['outro', 'post-credits'].includes(item.segment_type)
        && end - start <= (item.segment_type === 'outro' ? 900 : 600)));
  });
}

function normalizeMovieExportItem(item) {
  return {
    imdb_id: item.imdb_id,
    is_movie: true,
    segment_type: item.segment_type,
    start_sec: item.start_sec,
    end_sec: item.end_sec,
  };
}

function normalizeExportItem(item) {
  return isMovieItem(item) ? normalizeMovieExportItem(item) : item;
}

export async function exportJSON() {
  if (!state.allItems.length) {
    toast('No timestamps yet.');
    return;
  }
  const requiresTvdb = hasTvItems(state.allItems);
  if (requiresTvdb && !state.tvdbApiKey) {
    toast('Please enter your own TVDB API key before exporting JSON.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  toast(requiresTvdb ? 'Validating JSON export against TVDB...' : 'Preparing movie JSON export...');
  const mapped = await mapCapturedItemsWithTvdb('JSON export');
  const mappedItems = mapped.items;
  let items = filterShortOutputSegments(mappedItems);
  const shortSegmentCount = mappedItems.length - items.length;
  if (shortSegmentCount > 0) {
    toast(`${shortSegmentCount} invalid or unsupported segment(s) removed from export.`);
  }
  if (!items.length) {
    if (mappedItems.length && shortSegmentCount === mappedItems.length) {
      toast(`All mapped segments have invalid durations or unsupported movie types; nothing was exported.`);
      return;
    }
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    const noMappingMessage = hasTvItems(mapped.capturedItems)
      ? 'No series has a reliable TVDB episode mapping; nothing was exported.'
      : 'No movie has a usable IMDb ID; nothing was exported.';
    toast(onlySpecials ? 'Only provider specials were captured; nothing was exported.' : noMappingMessage);
    return;
  }

  const mediaKeys = [...new Set(
    items
      .map(getItemCacheKey)
  )];
  toast(`Checking IntroDB for existing segments (${mediaKeys.length} media item(s))...`);
  const canonicalExisting = new Map(await Promise.all(mediaKeys.map(async key => [
    key,
    await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
  ])));

  items = await filterMoviesWithKnownExtraScenes(items, canonicalExisting);
  if (!items.length) {
    toast('No movies eligible for export; see the scene exclusion or TMDB check message.');
    return;
  }
  const beforeCount = items.length;
  items = items.filter(item => {
    const key = getItemCacheKey(item);
    return !hasExistingSegment(canonicalExisting.get(key), item);
  });
  const duplicateCount = beforeCount - items.length;
  if (duplicateCount > 0) toast(`${duplicateCount} duplicate(s) already in IntroDB removed from export.`);
  if (!items.length) {
    toast('Nothing left to export after removing duplicates.');
    return;
  }

  const exportItems = items.map(normalizeExportItem);
  const groups = new Map();
  for (const item of exportItems) {
    const key = item.imdb_id || 'no_id';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const files = [];
  const maxItemsPerFile = 100;
  for (const [imdbId, groupItems] of groups) {
    const total = Math.ceil(groupItems.length / maxItemsPerFile);
    for (let index = 0; index < total; index++) {
      files.push({
        imdbId,
        part: total > 1 ? `_part${index + 1}of${total}` : '',
        data: groupItems.slice(index * maxItemsPerFile, (index + 1) * maxItemsPerFile),
      });
    }
  }

  let downloaded = 0;
  function downloadNext(index) {
    if (index >= files.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${exportItems.length} entries`);
      return;
    }
    const file = files[index];
    const blob = new Blob([JSON.stringify({ items: file.data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), {
      href: url,
      download: `timestamps_${file.imdbId}${file.part}.json`,
    });
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    downloaded++;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTimeout(() => downloadNext(index + 1), 400);
  }

  showExportPreview({
    items: exportItems,
    fileCount: files.length,
    duplicateCount,
    onConfirm: () => downloadNext(0),
  });
}

function updateSubmitBtn(label) {
  const button = document.getElementById('nfe-submit');
  if (button) button.textContent = label;
}

export async function submitToIntroDB() {
  if (!state.allItems.length) {
    toast('No timestamps to submit.');
    return;
  }
  if (!state.introdbApiKey) {
    toast('Please enter your IntroDB API key in the panel above.');
    setIntrodbStatus('No API key configured');
    return;
  }
  const requiresTvdb = hasTvItems(state.allItems);
  if (requiresTvdb && !state.tvdbApiKey) {
    toast('Please enter your own TVDB API key in the panel above.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  state.submitInProgress = true;
  updateSubmitBtn(requiresTvdb ? 'Checking TVDB...' : 'Preparing submission...');
  const stopSubmission = () => {
    state.submitInProgress = false;
    updateSubmitBtn('Submit to IntroDB');
  };

  const mapped = await mapCapturedItemsWithTvdb('IntroDB submission');
  const capturedItems = mapped.capturedItems;
  const mappedItems = mapped.items;
  const allMapped = filterShortOutputSegments(mappedItems);
  const shortSegmentCount = mappedItems.length - allMapped.length;
  if (shortSegmentCount > 0) {
    toast(`${shortSegmentCount} invalid or unsupported segment(s) skipped.`);
  }
  if (!allMapped.length) {
    if (mappedItems.length && shortSegmentCount === mappedItems.length) {
      toast(`All mapped segments have invalid durations or unsupported movie types; nothing was submitted.`);
      setIntrodbStatus(`Nothing submitted: segments must be at least ${MIN_OUTPUT_SEGMENT_DURATION_SECONDS} seconds`);
      stopSubmission();
      return;
    }
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    const noMappingMessage = hasTvItems(mapped.capturedItems)
      ? 'No series has a reliable TVDB episode mapping; nothing was submitted.'
      : 'No movie has a usable IMDb ID; nothing was submitted.';
    toast(onlySpecials ? 'Only provider specials were captured; nothing was submitted.' : noMappingMessage);
    setIntrodbStatus(onlySpecials ? 'Nothing submitted: specials are excluded' : noMappingMessage);
    stopSubmission();
    return;
  }

  const mediaKeys = [...new Set(
    allMapped
      .filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')
      .map(getItemCacheKey)
  )];
  toast(`Checking IntroDB for existing segments (${mediaKeys.length} media item(s))...`);
  const canonicalExisting = new Map(await Promise.all(mediaKeys.map(async key => [
    key,
    await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
  ])));

  const safeMapped = await filterMoviesWithKnownExtraScenes(allMapped, canonicalExisting);
  if (!safeMapped.length) {
    setIntrodbStatus('Nothing submitted: extra scene detected or TMDB check unavailable');
    stopSubmission();
    return;
  }
  const items = safeMapped.filter(item => {
    const key = getItemCacheKey(item);
    return !hasExistingSegment(canonicalExisting.get(key), item);
  });
  const skipped = capturedItems.length - items.length;
  if (!items.length) {
    toast('All timestamps already exist in IntroDB.');
    setIntrodbStatus('Nothing new to submit (all duplicates)');
    stopSubmission();
    return;
  }

  const skipMessage = skipped > 0 ? ` (${skipped} skipped or already existed)` : '';
  const ids = [...new Set(items.map(item => item.imdb_id))].join(', ');
  if (!confirm(`Submit ${items.length} timestamp${items.length !== 1 ? 's' : ''} to IntroDB?${skipMessage}\nID(s): ${ids}`)) {
    stopSubmission();
    return;
  }

  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn(`Submitting 0/${items.length}...`);
  let sent = 0;

  function sendNext(index) {
    if (index >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('Submit to IntroDB');
      toast(`IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      setIntrodbStatus(`${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      return;
    }

    const item = items[index];
    submitSegment(item, state.introdbApiKey).then(result => {
      sent++;
      if (result.success) {
        state.submitResults.ok++;
      } else {
        state.submitResults.fail++;
        console.warn('[NFE] IntroDB rejected:', result.status, item);
      }
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(index + 1), 150);
    }).catch(() => {
      sent++;
      state.submitResults.fail++;
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(index + 1), 150);
    });
  }

  sendNext(0);
}

export function clearData() {
  if (!confirm('Delete all captured timestamps?')) return;
  const introdbApiKey = state.introdbApiKey;
  const { apiKey: tvdbApiKey, pin: tvdbPin } = loadTvdbSettings();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, createState(activeProviderConfig.name), { introdbApiKey, tvdbApiKey, tvdbPin });
  updateCounters();
  updatePanelTitle();
  setDbStatus(`Waiting for ${activeProviderConfig.name} metadata...`);
  setIntrodbStatus('');
  updateImdbInput();
  toast('Data cleared');
}

function configurePanelCallbacks() {
  window.nfePanelCallbacks = {
    onDiagnostics: () => {
      const movies = state.skyShowtimeMovieDiagnostics || [];
      if (!movies.length) { toast('Open a SkyShowtime movie first to capture its markers.'); return; }
      const blob = new Blob([JSON.stringify({ provider: 'skyshowtime', movies }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: 'skyshowtime-movie-diagnostics.json' });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onClose: closePanel,
    onExport: exportJSON,
    onSubmit: submitToIntroDB,
    onClear: clearData,
    onImdbSet: () => {
      const value = document.getElementById('nfe-imdb-input').value.trim();
      if (!value) return;
      state.imdbId = value;
      applyImdbIdToShow(value, state.showId, { overwrite: true });
      state.dedupCacheV2 = {};
      setDbStatus(`ID saved: ${value}`);
      updateCounters();
      loadExistingSegments(value);
      lookupImdbTitle(value).then(result => {
        if (!result.success) return;
        state.showTitle = result.title;
        state.showYear = result.year ? String(result.year) : '';
        updatePanelTitle();
      });
    },
    onImdbSearch: () => {
      const manual = document.getElementById('nfe-imdb-input').value.trim();
      const query = manual || state.showTitle;
      if (!query) { toast('No title detected yet.'); return; }
      state.dbSearchDone = false;
      state.dedupCacheV2 = {};
      const searchShowId = state.showId;
      searchImdbByTitle(query, state.showYear, { mediaType: state.mediaType || 'tv' }).then(result => {
        if (result.success) {
          applyImdbIdToShow(result.imdbId, searchShowId);
          if (searchShowId && state.showId !== searchShowId) return;
          state.imdbId = result.imdbId;
          updateImdbInput();
          setDbStatus(`Found: ${result.imdbId}`);
          updateCounters();
          loadExistingSegments(result.imdbId);
        } else {
          setDbStatus(`IMDb lookup failed: ${result.error}`);
        }
      }).catch(error => {
        console.error('[NFE] Manual IMDb search error:', error);
        setDbStatus('IMDb lookup error');
      });
    },
    onTmdbSet: () => {
      const input = document.getElementById('nfe-tmdb-input');
      const saved = saveTmdbToken(input.value);
      input.value = '';
      toast(saved ? 'TMDB token updated locally; movie checks run on export and upload.' : 'Could not save TMDB token.');
    },
    onApikeySet: () => {
      const value = document.getElementById('nfe-apikey-input').value.trim();
      if (!value) {
        toast('Please enter an IntroDB API key.');
        return;
      }
      saveIntrodbSettings(value);
      document.getElementById('nfe-apikey-input').value = '';
      setIntrodbStatus('API key saved locally');
      toast('IntroDB API key saved locally');
    },
    onTvdbSet: () => {
      const apiKey = document.getElementById('nfe-tvdb-apikey-input').value.trim();
      const pin = document.getElementById('nfe-tvdb-pin-input').value.trim();
      if (!apiKey) {
        toast('Please enter your own TVDB API key.');
        setTvdbStatus('No TVDB API key configured');
        return;
      }
      saveTvdbSettings(apiKey, pin);
      document.getElementById('nfe-tvdb-apikey-input').value = '';
      document.getElementById('nfe-tvdb-pin-input').value = '';
      setTvdbStatus('TVDB credentials saved locally');
      toast('TVDB credentials saved locally');
    },
  };
}

function setupPanelHandler() {
  document.addEventListener('click', event => {
    const panel = document.getElementById('nfe-panel');
    const button = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(event.target) && !button?.contains(event.target)) closePanel();
  }, true);
}

function syncVisibility() {
  if (!state.panelVisible) return;
  if (state.updateRequired) {
    const panel = document.getElementById('nfe-panel');
    if (panel) {
      panel.style.opacity = '1';
      panel.style.pointerEvents = 'auto';
    }
    return;
  }
  const controls =
    document.querySelector('[data-uia="controls-standard"]') ||
    document.querySelector('[class*="PlayerControls"]') ||
    document.querySelector('.watch-video--bottom-controls-container');
  if (!controls) return;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  const visible = parseFloat(getComputedStyle(controls).opacity) > 0.05;
  const opacity = visible ? '1' : '0';
  const pointerEvents = visible ? 'auto' : 'none';
  if (panel.style.opacity !== opacity) panel.style.opacity = opacity;
  if (panel.style.pointerEvents !== pointerEvents) panel.style.pointerEvents = pointerEvents;
}

function setButtonVisibility(visible) {
  const button = document.getElementById('nfe-btn');
  if (!button) return;
  const opacity = visible ? '0.85' : '0';
  const pointerEvents = visible ? 'auto' : 'none';
  if (button.style.opacity !== opacity) button.style.opacity = opacity;
  if (button.style.pointerEvents !== pointerEvents) button.style.pointerEvents = pointerEvents;
}

function resetButtonIdleTimer() {
  clearTimeout(buttonHideTimer);
  setButtonVisibility(true);
  buttonHideTimer = setTimeout(() => {
    buttonHideTimer = null;
    setButtonVisibility(false);
  }, BUTTON_IDLE_DELAY_MS);
}

function setupControlVisibilityHandler() {
  let framePending = false;
  let trailingSyncTimer = null;
  const scheduleFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : callback => setTimeout(callback, 0);

  document.addEventListener('mousemove', () => {
    if (framePending) return;
    framePending = true;
    scheduleFrame(() => {
      framePending = false;
      resetButtonIdleTimer();
      syncVisibility();
      if (trailingSyncTimer != null) clearTimeout(trailingSyncTimer);
      trailingSyncTimer = setTimeout(() => {
        trailingSyncTimer = null;
        syncVisibility();
      }, 250);
    });
  }, true);
}

export function bootstrapProvider({
  providerName,
  setupInterception,
  isPlayerPage = () => true,
}) {
  activeProviderConfig = getProviderConfig(providerName);
  Object.assign(state, createState(activeProviderConfig.name));
  loadIntrodbSettings();
  loadTvdbSettings();
  setProviderName(providerName);
  configurePanelCallbacks();
  setupInterception();
  setupPanelHandler();
  setupControlVisibilityHandler();
  checkForRequiredUpdate().then(result => {
    if (!result.required) return;
    state.allItems = [];
    state.interceptedCount = 0;
    const showNotice = () => {
      if (document.body) showRequiredUpdate();
      else setTimeout(showNotice, 50);
    };
    showNotice();
  });

  let lastPath = location.pathname;
  setInterval(() => {
    if (state.updateRequired) {
      if (!document.getElementById('nfe-panel') && document.body) showRequiredUpdate();
      syncVisibility();
      return;
    }

    const inPlayer = isPlayerPage();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      document.getElementById('nfe-btn')?.remove();
      if (!inPlayer) {
        document.getElementById('nfe-panel')?.remove();
        state.panelVisible = false;
      }
    }
    if (inPlayer) {
      const buttonMissing = !document.getElementById('nfe-btn');
      if (buttonMissing) {
        injectBtn(providerName, getNextEpBtn);
        resetButtonIdleTimer();
      }
      syncVisibility();
    }
  }, 1000);

  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  win.__segmentScraper = {
    getAll: () => state.allItems,
    get state() {
      const { introdbApiKey, tvdbApiKey, tvdbPin, ...publicState } = state;
      return publicState;
    },
  };
}
