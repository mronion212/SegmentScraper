/**
 * Shared provider bootstrap and control flow.
 * The Netflix UI/controls are the single source of truth for every provider.
 */

import { state, createState, createEpisodeCacheKey } from '../core/state.js';
import { searchImdbByTitle, lookupImdbTitle, loadExistingSegments, loadExistingSegmentsForEpisode, submitSegment } from '../core/network.js';
import { injectBtn, getNextEpBtn } from '../ui/button.js';
import { setProviderName, closePanel, updateCounters, updatePanelTitle, toast, updateImdbInput, showExportPreview } from '../ui/panel.js';
import { getProviderConfig } from '../config/provider-config.js';
import { loadIntrodbSettings, saveIntrodbSettings } from '../core/introdb-settings.js';
import { loadTvdbSettings, saveTvdbSettings, mapSeriesItemsToTvdb } from '../core/tvdb.js';

const BUTTON_IDLE_DELAY_MS = 3000;
let activeProviderConfig = getProviderConfig('netflix');
let buttonHideTimer;

export function setDbStatus(msg) {
  state.dbStatusMsg = msg;
  const el = document.getElementById('nfe-imdb-status');
  if (el) el.textContent = `IMDb ID: ${state.imdbId || 'Not set'}`;
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
export function handleDetectedShow({ title, showId = null, year = '', imdbOverride = null }) {
  if (title && title !== state.showTitle) {
    state.showTitle = title;
    state.showId = showId != null ? String(showId) : null;
    if (state.showId) state.showIds.add(state.showId);
    state.showYear = year ? String(year) : '';
    state.dbSearchDone = false;
    state.imdbId = '';
    state.dedupCacheV2 = {};
    state.providerEpisodes = [];
    updatePanelTitle();
  }

  if (state.dbSearchDone || !state.showTitle) return;
  state.dbSearchDone = true;

  if (imdbOverride) {
    state.imdbId = imdbOverride;
    state.allItems.forEach(item => {
      if (item.imdb_id === 'IMDB_PENDING') item.imdb_id = imdbOverride;
    });
    updateImdbInput();
    setDbStatus(`Manual override applied · ID: ${imdbOverride}`);
    updateCounters();
    loadExistingSegments(imdbOverride);
    return;
  }

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
    console.error('[NFE] IMDb search error:', error);
    setDbStatus('IMDb lookup error');
  });
}

/** Store extractor output and update the shared counters/toast identically. */
export function recordExtractedSegments(items) {
  if (!items.length) return;
  state.allItems.push(...items);
  state.interceptedCount++;
  updateCounters();
  toast(`+${items.length} timestamps captured · total: ${state.allItems.length}`);
}

export function isAlreadyInIntroDB(item) {
  const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
  return state.dedupCacheV2[key]?.has(item.segment_type) ?? false;
}

export function filterShortSegments(items) {
  const filteredItems = items.filter(item => item.end_sec - item.start_sec >= 5);
  return {
    items: filteredItems,
    skipped: items.length - filteredItems.length,
  };
}

async function mapCapturedItemsWithTvdb(action) {
  const capturedItems = state.allItems.slice();
  const pendingItems = capturedItems.filter(item => !item.imdb_id || item.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length) {
    toast(`${pendingItems.length} timestamp(s) without an IMDb ID will be skipped from ${action}.`);
  }

  const seriesGroups = new Map();
  for (const item of capturedItems.filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')) {
    if (!seriesGroups.has(item.imdb_id)) seriesGroups.set(item.imdb_id, []);
    seriesGroups.get(item.imdb_id).push(item);
  }

  const items = [];
  let unreliableSkipped = 0;
  let specialSegmentsExcluded = 0;
  const reasonLabels = {
    genericTitle: 'generic title',
    missingTitle: 'missing title',
    duplicateProviderTitle: 'duplicate provider title',
    noExactMatch: 'no exact normalized TVDB match',
    ambiguousTvdbTitle: 'ambiguous TVDB title',
    reusedTvdbEpisode: 'TVDB episode already matched',
  };
  const describeReasons = reasons => Object.entries(reasons || {})
    .map(([reason, count]) => `${reasonLabels[reason] || reason}: ${count}`)
    .join(', ') || 'none';
  for (const [imdbId, seriesItems] of seriesGroups) {
    const catalog = imdbId === state.imdbId ? state.providerEpisodes : [];
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

export async function exportJSON() {
  if (!state.allItems.length) {
    toast('No timestamps yet.');
    return;
  }
  if (!state.tvdbApiKey) {
    toast('Please enter your own TVDB API key before exporting JSON.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  toast('Validating JSON export against TVDB...');
  const mapped = await mapCapturedItemsWithTvdb('JSON export');
  let items = mapped.items;
  if (!items.length) {
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    toast(onlySpecials ? 'Only provider specials were captured; nothing was exported.' : 'No series has a reliable TVDB episode mapping; nothing was exported.');
    return;
  }

  const shortSegments = filterShortSegments(items);
  items = shortSegments.items;
  if (shortSegments.skipped > 0) {
    toast(`${shortSegments.skipped} segment(s) under 5 seconds removed from export.`);
  }
  if (!items.length) {
    toast('Nothing left to export after removing segments under 5 seconds.');
    return;
  }

  const episodeKeys = [...new Set(
    items
      .map(item => createEpisodeCacheKey(item.imdb_id, item.season, item.episode))
  )];
  toast(`Checking IntroDB for existing segments (${episodeKeys.length} canonical episode(s))...`);
  const canonicalExisting = new Map(await Promise.all(episodeKeys.map(async key => [
    key,
    await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
  ])));

  const beforeCount = items.length;
  items = items.filter(item => {
    const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
    return !canonicalExisting.get(key)?.has(item.segment_type);
  });
  const duplicateCount = beforeCount - items.length;
  if (duplicateCount > 0) toast(`${duplicateCount} duplicate(s) already in IntroDB removed from export.`);
  if (!items.length) {
    toast('Nothing left to export after removing duplicates.');
    return;
  }

  const groups = new Map();
  for (const item of items) {
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

  const downloads = files.map(file => {
    const blob = new Blob([JSON.stringify({ items: file.data }, null, 2)], { type: 'application/json' });
    return {
      url: URL.createObjectURL(blob),
      filename: `timestamps_${file.imdbId}${file.part}.json`,
    };
  });
  let downloaded = 0;
  const revokeDownloads = () => downloads.forEach(download => URL.revokeObjectURL(download.url));

  function handleDownload(index) {
    downloaded++;
    setTimeout(() => URL.revokeObjectURL(downloads[index].url), 1000);
    if (downloaded === downloads.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${items.length} entries`);
    }
  }

  showExportPreview({
    items,
    fileCount: files.length,
    duplicateCount,
    shortSegmentCount: shortSegments.skipped,
    downloads,
    onDownload: handleDownload,
    onCancel: revokeDownloads,
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
  if (!state.tvdbApiKey) {
    toast('Please enter your own TVDB API key in the panel above.');
    setTvdbStatus('No TVDB API key configured');
    return;
  }
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  state.submitInProgress = true;
  updateSubmitBtn('Checking TVDB...');
  const stopSubmission = () => {
    state.submitInProgress = false;
    updateSubmitBtn('Submit to IntroDB');
  };

  const mapped = await mapCapturedItemsWithTvdb('IntroDB submission');
  const capturedItems = mapped.capturedItems;
  let allMapped = mapped.items;
  if (!allMapped.length) {
    const onlySpecials = mapped.specialSegmentsExcluded > 0 && mapped.unreliableSkipped === 0 && mapped.pendingSkipped === 0;
    toast(onlySpecials ? 'Only provider specials were captured; nothing was submitted.' : 'No series has a reliable TVDB episode mapping; nothing was submitted.');
    setIntrodbStatus(onlySpecials ? 'Nothing submitted: specials are excluded' : 'Submission blocked: TVDB mapping unavailable or unreliable');
    stopSubmission();
    return;
  }

  const shortSegments = filterShortSegments(allMapped);
  allMapped = shortSegments.items;
  if (shortSegments.skipped > 0) {
    toast(`${shortSegments.skipped} segment(s) under 5 seconds skipped from IntroDB submission.`);
  }
  if (!allMapped.length) {
    toast('Nothing left to submit after removing segments under 5 seconds.');
    setIntrodbStatus('Nothing submitted: all segments were under 5 seconds');
    stopSubmission();
    return;
  }

  const episodeKeys = [...new Set(
    allMapped
      .filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')
      .map(item => createEpisodeCacheKey(item.imdb_id, item.season, item.episode))
  )];
  toast(`Checking IntroDB for existing segments (${episodeKeys.length} canonical episode(s))...`);
  const canonicalExisting = new Map(await Promise.all(episodeKeys.map(async key => [
    key,
    await loadExistingSegmentsForEpisode(key, undefined, { useCache: false, writeCache: false }),
  ])));

  const items = allMapped.filter(item => {
    const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
    return !canonicalExisting.get(key)?.has(item.segment_type);
  });
  const skipped = capturedItems.length - items.length;
  if (!items.length) {
    toast('All timestamps already exist in IntroDB.');
    setIntrodbStatus('Nothing new to submit (all duplicates)');
    stopSubmission();
    return;
  }

  const skipDetails = [];
  if (shortSegments.skipped > 0) skipDetails.push(`${shortSegments.skipped} under 5 seconds`);
  if (skipped - shortSegments.skipped > 0) skipDetails.push(`${skipped - shortSegments.skipped} otherwise skipped or already existed`);
  const skipMessage = skipDetails.length ? ` (${skipDetails.join('; ')})` : '';
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
    onClose: closePanel,
    onExport: exportJSON,
    onSubmit: submitToIntroDB,
    onClear: clearData,
    onImdbSet: () => {
      const value = document.getElementById('nfe-imdb-input').value.trim();
      if (!value) return;
      state.imdbId = value;
      state.allItems.forEach(item => { item.imdb_id = value; });
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
      searchImdbByTitle(query, state.showYear).then(result => {
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
        console.error('[NFE] Manual IMDb search error:', error);
        setDbStatus('IMDb lookup error');
      });
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
  const controls =
    document.querySelector('[data-uia="controls-standard"]') ||
    document.querySelector('[class*="PlayerControls"]') ||
    document.querySelector('.watch-video--bottom-controls-container');
  if (!controls || !state.panelVisible) return;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  const visible = parseFloat(getComputedStyle(controls).opacity) > 0.05;
  panel.style.opacity = visible ? '1' : '0';
  panel.style.pointerEvents = visible ? 'auto' : 'none';
}

function setButtonVisibility(visible) {
  const button = document.getElementById('nfe-btn');
  if (!button) return;
  button.style.opacity = visible ? '0.85' : '0';
  button.style.pointerEvents = visible ? 'auto' : 'none';
}

function resetButtonIdleTimer() {
  clearTimeout(buttonHideTimer);
  setButtonVisibility(true);
  buttonHideTimer = setTimeout(() => setButtonVisibility(false), BUTTON_IDLE_DELAY_MS);
}

function setupControlVisibilityHandler() {
  document.addEventListener('mousemove', () => {
    resetButtonIdleTimer();
    syncVisibility();
    setTimeout(syncVisibility, 250);
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

  let lastPath = location.pathname;
  setInterval(() => {
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
      injectBtn(providerName, getNextEpBtn);
      if (buttonMissing) resetButtonIdleTimer();
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
