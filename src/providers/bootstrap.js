/**
 * Shared provider bootstrap and control flow.
 * The Netflix UI/controls are the single source of truth for every provider.
 */

import { state, createState, createMediaCacheKey } from '../core/state.js';
import { outputSegmentAllowed, capturedSegmentKey, movieCaptureAllowedForProvider, providerCaptureAllowed } from '../core/output-policy.js';
import { restoreCaptureSession, scheduleCaptureSave, saveCaptureSession, clearCaptureSession } from '../core/capture-session.js';
import { checkForRequiredUpdate } from '../core/update-check.js';
import { searchImdbByTitle, lookupImdbTitle, loadExistingSegments, loadExistingSegmentsForEpisode, submitSegment } from '../core/network.js';
import { injectBtn, getNextEpBtn, removePlayerButton } from '../ui/button.js';
import { setProviderName, closePanel, updateCounters, updatePanelTitle, toast, updateImdbInput, showExportPreview, showRequiredUpdate } from '../ui/panel.js';
import { getProviderConfig } from '../config/provider-config.js';
import { loadIntrodbSettings, saveIntrodbSettings } from '../core/introdb-settings.js';
import { checkTmdbExtraScenes, saveTmdbToken } from '../core/tmdb.js';
import { loadTvdbSettings, saveTvdbSettings, mapSeriesItemsToTvdb } from '../core/tvdb.js';


let activeProviderConfig = getProviderConfig('netflix');
let activeProviderName = 'netflix';
const introdbChecksInFlight = new Map();


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

function existingSegmentsForDisplay(existing) {
  const rangesByType = existing?.rangesByType;
  if (!rangesByType?.entries) return [];
  const segments = [];
  for (const [segmentType, ranges] of rangesByType.entries()) {
    for (const range of ranges || []) {
      segments.push({
        segment_type: segmentType,
        start_sec: Number(range.startSec),
        end_sec: Number(range.endSec),
        credit_part: range.creditPart ?? null,
      });
    }
  }
  return segments;
}

function ensureIntrodbSegments(items) {
  const keys = [...new Set((items || [])
    .filter(item => item?.imdb_id && item.imdb_id !== 'IMDB_PENDING')
    .map(getItemCacheKey))];
  for (const key of keys) {
    if (state.dedupCacheV2[key] || introdbChecksInFlight.has(key)) continue;
    const promise = loadExistingSegmentsForEpisode(key)
      .then(existing => {
        const count = existing?.rangesByType ? existingSegmentsForDisplay(existing).length : 0;
        if (count) setIntrodbStatus(`IntroDB timestamps loaded for the current item (${count}). Compare them with the Scraper result in Show timestamps.`);
        return existing;
      })
      .catch(error => {
        console.warn('[NFE-DEDUP] Could not load current IntroDB timestamps:', error);
        setIntrodbStatus(error.message);
        return null;
      })
      .finally(() => introdbChecksInFlight.delete(key));
    introdbChecksInFlight.set(key, promise);
  }
}

function loadCurrentIntrodbSegments(imdbId) {
  return loadExistingSegments(imdbId).then(segments => {
    const currentItems = state.allItems.filter(item => item.imdb_id === imdbId);
    if (currentItems.length && segments.length) {
      setIntrodbStatus(`IntroDB timestamps loaded for ${currentItems.length} captured item${currentItems.length === 1 ? '' : 's'}. Compare them with the Scraper result in Show timestamps.`);
    }
    ensureIntrodbSegments(currentItems);
    return segments;
  });
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
  scheduleCaptureSave();
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
  const feedback = document.getElementById('nfe-imdb-feedback');
  if (feedback) feedback.textContent = msg;
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

  if (normalizedMediaType === 'movie' && !movieCaptureAllowedForProvider(activeProviderName)) {
    state.dbSearchDone = true;
    setDbStatus(`${activeProviderConfig.name} movie credit capture is temporarily disabled; TV series capture remains active.`);
    setTvdbStatus('Movie capture is temporarily disabled');
    updateCounters();
    return;
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
    loadCurrentIntrodbSegments(imdbOverride).catch(error => setIntrodbStatus(error.message));
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
      loadCurrentIntrodbSegments(result.imdbId).catch(error => setIntrodbStatus(error.message));
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

function removeDisabledMovieCaptures(providerName) {
  if (movieCaptureAllowedForProvider(providerName)) return 0;
  const retained = state.allItems.filter(item => providerCaptureAllowed(item, providerName));
  const removed = state.allItems.length - retained.length;
  if (!removed) return 0;
  state.allItems = retained;
  scheduleCaptureSave();
  updateCounters();
  console.info(`[NFE] Removed ${removed} movie capture(s); movie credits are temporarily disabled for ${activeProviderConfig.name}.`);
  return removed;
}

/** Store extractor output and update the shared counters/toast identically. */
export function recordExtractedSegments(items, providerName = activeProviderName) {
  if (state.updateRequired) return;
  if (!Array.isArray(items) || !items.length) return;
  const receivedCount = items.length;
  items = items.filter(item => providerCaptureAllowed(item, providerName));
  if (items.length !== receivedCount) {
    const providerLabel = activeProviderConfig?.name || providerName;
    console.info(`[NFE] Skipped ${receivedCount - items.length} movie capture(s); movie credits are temporarily disabled for ${providerLabel}.`);
    setDbStatus(`${providerLabel} movie credits are temporarily disabled; TV segments remain active.`);
  }
  if (!items.length) return;
  const keys = new Set(state.allItems.map(capturedSegmentKey));
  items = items.filter(item => {
    const key = capturedSegmentKey(item);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (!items.length) return;
  state.allItems.push(...items);
  scheduleCaptureSave();
  state.interceptedCount++;
  updateCounters();
  ensureIntrodbSegments(items);
  toast(`+${items.length} timestamps captured · total: ${state.allItems.length}`);
}

export function isAlreadyInIntroDB(item) {
  const key = getItemCacheKey(item);
  return hasExistingSegment(state.dedupCacheV2[key], item);
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
      return true;
    });
  }
  return existing.has?.(item.segment_type) ?? false;
}

const overviewSource = Symbol('overviewSource');

async function mapCapturedItemsWithTvdb(action, capturedItems = state.allItems.slice()) {
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

function filterShortOutputSegments(items) {
  return items.filter(outputSegmentAllowed);
}

function annotateExistingComparison(row, item, existing) {
  if (!row || !existing || existing.error) return;
  row.existingSegments = existingSegmentsForDisplay(existing);
  row.existingRanges = existing.rangesByType?.get(item.segment_type) || [];
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

async function loadCanonicalExisting(episodeKeys) {
  const results = new Map();
  // Avoid bursts of hundreds of requests for large captured catalogues.
  for (let index = 0; index < episodeKeys.length; index += 4) {
    const batch = await Promise.all(episodeKeys.slice(index, index + 4).map(async key => [
      key, await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
    ]));
    for (const [key, value] of batch) results.set(key, value);
  }
  return results;
}

export async function exportJSON() {
  if (state.exportInProgress || state.submitInProgress) {
    toast('An operation is already in progress. Please wait.');
    return;
  }
  state.exportInProgress = true;
  try { await prepareJSONExport(); }
  catch (error) {
    toast(error.message || 'Export failed. Please try again.');
    setIntrodbStatus('Export stopped. Please try again when the connection is available.');
  } finally { state.exportInProgress = false; }
}

async function prepareJSONExport() {
  if (!state.allItems.length) {
    toast('No timestamps yet.');
    return;
  }
  const capturedItems = state.allItems.map((item, index) => ({ ...item, [overviewSource]: index }));
  const view = {
    items: [], fileCount: 0, duplicateCount: 0, checking: true,
    rows: capturedItems.map(item => ({ item, status: 'Checking', reason: '' })),
    message: 'Checking TVDB mapping and IntroDB…',
  };
  const refresh = showExportPreview(view);
  try {
    if (hasTvItems(capturedItems) && !state.tvdbApiKey) {
      revealApiSettings();
      toast('Please enter your own TVDB API key before exporting JSON.');
      setTvdbStatus('No TVDB API key configured');
      view.message = 'TVDB API key missing. Timestamps remain available; JSON download is disabled.';
      return;
    }
    if (state.submitInProgress) {
      toast('Submission in progress, please wait...');
      return;
    }

    toast('Validating JSON export against TVDB...');
    const mapped = await mapCapturedItemsWithTvdb('JSON export', capturedItems);
    const mappedItems = mapped.items;
    for (const row of view.rows) {
      row.status = 'Unavailable';
      row.reason = !row.item.imdb_id || row.item.imdb_id === 'IMDB_PENDING'
        ? 'Missing IMDb ID' : 'No reliable TVDB mapping / excluded special';
    }
    for (const item of mappedItems) {
      const row = view.rows[item[overviewSource]];
      if (row) {
        row.canonical = item;
        row.status = 'Checking';
        row.reason = '';
        if (!filterShortOutputSegments([item]).length) {
          row.status = 'Unavailable';
          row.reason = 'Invalid duration or unsupported segment type';
        }
      }
    }
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
      const noMappingMessage = 'No series has a reliable TVDB episode mapping; nothing was exported.';
      toast(onlySpecials ? 'Only provider specials were captured; nothing was exported.' : noMappingMessage);
      return;
    }

    const episodeKeys = [...new Set(
      items
        .map(item => getItemCacheKey(item))
    )];
    toast(`Checking IntroDB for existing segments (${episodeKeys.length} media item(s))...`);
    const canonicalExisting = new Map();
    for (let index = 0; index < episodeKeys.length; index += 4) {
      await Promise.all(episodeKeys.slice(index, index + 4).map(async key => {
        try {
          canonicalExisting.set(key, await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }));
        } catch (error) {
          canonicalExisting.set(key, { error: error?.message || 'IntroDB duplicate check failed.' });
        }
      }));
    }

    const eligibleMovies = await filterMoviesWithKnownExtraScenes(items.filter(item => !canonicalExisting.get(getItemCacheKey(item))?.error), canonicalExisting);
    const eligibleSet = new Set(eligibleMovies);
    for (const item of items) {
      if (isMovieItem(item) && !canonicalExisting.get(getItemCacheKey(item))?.error && !eligibleSet.has(item)) {
        const row = view.rows[item[overviewSource]];
        if (row) { row.status = 'Unavailable'; row.reason = 'Movie excluded by extra-scene checks'; }
      }
    }
    items = items.filter(item => !isMovieItem(item) || canonicalExisting.get(getItemCacheKey(item))?.error || eligibleSet.has(item));
    const uploadCandidates = items.filter(item => !canonicalExisting.get(getItemCacheKey(item))?.error);
    items = items.filter(item => {
      const key = getItemCacheKey(item);
      const existing = canonicalExisting.get(key);
      const row = view.rows[item[overviewSource]];
      const failed = Boolean(existing.error);
      const duplicate = !failed && hasExistingSegment(existing, item);
      if (row) {
        row.status = failed ? 'Unavailable' : duplicate ? 'In IntroDB' : 'NEW';
        row.reason = failed ? existing.error : '';
        annotateExistingComparison(row, item, existing);
      }
      if (failed) toast(existing.error);
      return !failed && !duplicate;
    });
    const duplicateCount = view.rows.filter(row => row.status === 'In IntroDB').length;
    view.duplicateCount = duplicateCount;
    if (duplicateCount > 0) toast(`${duplicateCount} duplicate(s) already in IntroDB removed from export.`);
    if (!items.length) {
      toast('Nothing left to export after removing duplicates.');
    }

    const exportItems = items.map(normalizeExportItem);
    const uploadItems = uploadCandidates.map(normalizeExportItem);
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
        const summary = `${downloaded} file(s) downloaded across ${groups.size} series · ${exportItems.length} entries`;
        document.getElementById('nfe-export-preview')?.remove();
        resetCapturedData(`${summary}; captured data cleared.`);
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

    Object.assign(view, {
      items: exportItems,
      fileCount: files.length,
      duplicateCount,
      uploadItems,
      onConfirm: exportItems.length ? () => downloadNext(0) : undefined,
      requiresApproval: uploadItems.length > 0,
      onUpload: uploadItems.length ? () => {
        if (!state.introdbApiKey) {
          revealApiSettings();
          toast('Please enter your IntroDB API key in API settings before uploading.');
          setIntrodbStatus('No API key configured');
          return;
        }
        startIntrodbUpload(uploadItems, { skipped: capturedItems.length - uploadItems.length });
      } : undefined,
    });
  } catch (error) {
    view.message = error.message || 'Validation failed. JSON download is disabled.';
    toast(view.message);
  } finally {
    view.checking = false;
    for (const row of view.rows) {
      if (row.status === 'Checking') {
        row.status = 'Unavailable';
        row.reason = view.message || 'Validation could not be completed';
      }
    }
    view.message = view.items.length
      ? 'Only verified NEW timestamps are included in the JSON download. Use Upload to IntroDB to submit the reviewed scraper ranges directly.'
      : view.uploadItems?.length
        ? 'No new JSON rows remain, but the reviewed scraper ranges can still be uploaded directly to IntroDB.'
        : 'JSON download unavailable. ' + (view.message.includes('Checking') ? 'No verified new timestamps.' : view.message);
    refresh?.(view);
  }
}

function updateSubmitBtn(label) {
  const button = document.getElementById('nfe-submit');
  if (button) button.textContent = label;
}

function startIntrodbUpload(items, { skipped = 0 } = {}) {
  if (!items?.length) return;
  state.submitInProgress = true;
  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn(`Submitting 0/${items.length}...`);
  let sent = 0;

  function sendNext(index) {
    if (index >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('Submit to IntroDB');
      const summary = `IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
      if (fail === 0 && ok > 0) {
        resetCapturedData(`${summary}; captured data cleared.`);
      } else {
        toast(summary);
        setIntrodbStatus(summary);
      }
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

export async function submitToIntroDB() {
  if (state.exportInProgress || state.submitInProgress) {
    toast('An operation is already in progress. Please wait.');
    return;
  }
  try { await prepareIntroDBSubmission(); }
  catch (error) {
    state.submitInProgress = false;
    updateSubmitBtn('Submit to IntroDB');
    toast(error.message || 'Submission failed. Please try again.');
    setIntrodbStatus('Submission stopped. Please try again when the connection is available.');
  }
}

async function prepareIntroDBSubmission() {
  if (!state.allItems.length) {
    toast('No timestamps to submit.');
    return;
  }
  if (!state.introdbApiKey) {
    revealApiSettings();
    toast('Please enter your IntroDB API key in API settings.');
    setIntrodbStatus('No API key configured');
    return;
  }
  const requiresTvdb = hasTvItems(state.allItems);
  if (requiresTvdb && !state.tvdbApiKey) {
    revealApiSettings();
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
      setIntrodbStatus(`Nothing submitted: segments must be at least 5 seconds`);
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
  const canonicalExisting = await loadCanonicalExisting(mediaKeys);

  const safeMapped = await filterMoviesWithKnownExtraScenes(allMapped, canonicalExisting);
  const safeSet = new Set(safeMapped);
  const rows = allMapped.map(item => ({ item, status: 'NEW', reason: '' }));
  for (const row of rows) {
    const existing = canonicalExisting.get(getItemCacheKey(row.item));
    annotateExistingComparison(row, row.item, existing);
    if (!safeSet.has(row.item)) {
      row.status = 'Unavailable';
      row.reason = 'Movie excluded by extra-scene checks';
    } else if (hasExistingSegment(existing, row.item)) {
      row.status = 'In IntroDB';
      row.reason = 'Exact range already exists in IntroDB';
    }
  }
  const items = safeMapped.filter(item => {
    const key = getItemCacheKey(item);
    return !hasExistingSegment(canonicalExisting.get(key), item);
  });
  const skipped = capturedItems.length - items.length;
  if (!items.length) {
    const allDuplicates = safeMapped.length > 0;
    const uploadItems = safeMapped.map(normalizeExportItem);
    toast(allDuplicates ? 'All timestamps already exist in IntroDB.' : 'No timestamps remain eligible for upload after the extra-scene checks.');
    setIntrodbStatus(allDuplicates ? 'Nothing new to submit (all duplicates)' : 'Nothing submitted: extra scene detected or TMDB check unavailable');
    showExportPreview({
      mode: 'submit',
      items: [],
      uploadItems,
      fileCount: 0,
      duplicateCount: rows.filter(row => row.status === 'In IntroDB').length,
      checking: false,
      rows,
      requiresApproval: uploadItems.length > 0,
      message: allDuplicates
        ? 'These scraper ranges already exist in IntroDB. Review the comparison, then use the direct upload button if you still want to submit them.'
        : 'No timestamp can be uploaded from this item. The current IntroDB timestamps remain visible for comparison.',
      onUpload: uploadItems.length ? () => startIntrodbUpload(uploadItems, { skipped: capturedItems.length - uploadItems.length }) : undefined,
    });
    stopSubmission();
    return;
  }

  showExportPreview({
    mode: 'submit',
    items,
    fileCount: items.length,
    duplicateCount: rows.filter(row => row.status === 'In IntroDB').length,
    checking: false,
    rows,
    message: 'Compare the Scraper and IntroDB lines, then explicitly approve this upload. Differences can be caused by provider offsets.',
    requiresApproval: true,
    approvalLabel: 'I manually compared every Scraper timestamp with the current IntroDB timestamp(s) for this exact video and approve this upload.',
    onCancel: stopSubmission,
    onConfirm: () => startIntrodbUpload(items, { skipped }),
  });
}

function resetCapturedData(message = 'Data cleared') {
  const introdbApiKey = state.introdbApiKey;
  const panelVisible = state.panelVisible;
  const { apiKey: tvdbApiKey, pin: tvdbPin } = loadTvdbSettings();
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, createState(activeProviderConfig.name), { introdbApiKey, tvdbApiKey, tvdbPin, panelVisible });
  clearCaptureSession();
  updateCounters();
  updatePanelTitle();
  setDbStatus(`Waiting for ${activeProviderConfig.name} metadata...`);
  setIntrodbStatus('');
  updateImdbInput();
  toast(message);
}

export function clearData() {
  if (state.submitInProgress || state.exportInProgress) { toast('Please wait until the current operation finishes.'); return; }
  if (!confirm('Delete all captured timestamps?')) return;
  resetCapturedData();
}

function revealApiSettings() {
  const settings = document.getElementById('nfe-settings');
  if (settings) settings.open = true;
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
      loadCurrentIntrodbSegments(value).catch(error => setIntrodbStatus(error.message));
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
          loadCurrentIntrodbSegments(result.imdbId).catch(error => setIntrodbStatus(error.message));
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
    if (event.target.closest?.('#nfe-export-preview')) return;
    const panel = document.getElementById('nfe-panel');
    const button = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(event.target) && !button?.contains(event.target)) closePanel();
  }, true);
}

function syncVisibility() {
  const panel = document.getElementById("nfe-panel");
  if (panel && state.panelVisible) {
    panel.style.opacity = "1";
    panel.style.pointerEvents = "auto";
  }
}

export function bootstrapProvider({
  providerName,
  setupInterception,
  isPlayerPage = () => Boolean(document.querySelector('video')),
}) {
  activeProviderName = String(providerName || 'netflix').trim().toLowerCase();
  activeProviderConfig = getProviderConfig(activeProviderName);
  Object.assign(state, createState(activeProviderConfig.name));
  restoreCaptureSession(activeProviderName);
  removeDisabledMovieCaptures(activeProviderName);
  window.addEventListener('pagehide', saveCaptureSession);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveCaptureSession(); });
  loadIntrodbSettings();
  loadTvdbSettings();
  setProviderName(providerName);
  configurePanelCallbacks();
  setupInterception();
  setupPanelHandler();
  checkForRequiredUpdate().then(result => {
    if (!result.required) return;
    saveCaptureSession();
    const showNotice = () => {
      if (document.body) showRequiredUpdate();
      else setTimeout(showNotice, 50);
    };
    showNotice();
  });

  let lastPath = location.pathname;
  let refreshTimer = null;
  const refreshControls = () => {
    refreshTimer = null;
    if (!document.body) return;
    if (state.updateRequired) {
      if (!document.getElementById('nfe-panel')) showRequiredUpdate();
      return;
    }
    const inPlayer = isPlayerPage();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      scheduleCaptureSave();
      if (!inPlayer) {
        document.getElementById('nfe-panel')?.remove();
        state.panelVisible = false;
      }
    }
    if (inPlayer) injectBtn(providerName, getNextEpBtn);
    else removePlayerButton();
    const host = document.fullscreenElement || document.body;
    for (const id of ['nfe-panel', 'nfe-export-preview', 'nfe-toast']) {
      const element = document.getElementById(id);
      if (element && element.parentElement !== host) host.appendChild(element);
    }
    syncVisibility();
  };
  const scheduleRefresh = () => {
    if (refreshTimer === null) refreshTimer = setTimeout(refreshControls, 100);
  };
  const observePlayer = () => {
    refreshControls();
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(records => {
      if (records.every(record => record.target.closest?.('[id^="nfe-"]'))) return;
      scheduleRefresh();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) observePlayer();
  else document.addEventListener('DOMContentLoaded', observePlayer, { once: true });
  document.addEventListener('fullscreenchange', refreshControls);
  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('resize', scheduleRefresh);
  // Backstop for history changes that do not mutate the player DOM.
  setInterval(() => { if (!document.hidden) refreshControls(); }, 5000);

  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  win.__segmentScraper = {
    getAll: () => state.allItems,
    get state() {
      const { introdbApiKey, tvdbApiKey, tvdbPin, ...publicState } = state;
      return publicState;
    },
  };
}
