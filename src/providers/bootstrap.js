/**
 * Shared provider bootstrap and control flow.
 * The Netflix UI/controls are the single source of truth for every provider.
 */

import { state, createState, createEpisodeCacheKey } from '../core/state.js';
import { searchImdbByTitle, lookupImdbTitle, loadExistingSegments, loadExistingSegmentsForEpisode, submitSegment } from '../core/network.js';
import { injectBtn, getNextEpBtn } from '../ui/button.js';
import { setProviderName, closePanel, updateCounters, updatePanelTitle, toast, updateImdbInput, showExportPreview } from '../ui/panel.js';
import { getProviderConfig } from '../config/provider-config.js';

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

export async function exportJSON() {
  if (!state.allItems.length) {
    toast('No timestamps yet.');
    return;
  }

  let items = state.allItems.map(({ _eid, ...rest }) => rest);
  const pendingCount = items.filter(item => item.imdb_id === 'IMDB_PENDING').length;
  if (pendingCount > 0 && !confirm(`${pendingCount} timestamp(s) still have no IMDb ID assigned (IMDB_PENDING).\nThese will be exported as-is. Continue?`)) return;

  const episodeKeys = [...new Set(
    items
      .filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')
      .map(item => `${item.imdb_id}|${item.season}|${item.episode}`)
  )];
  const notLoaded = episodeKeys.filter(key => !(state.dedupCacheV2 && state.dedupCacheV2[key]));
  if (notLoaded.length > 0) {
    toast(`Checking IntroDB for existing segments (${notLoaded.length} episode(s))...`);
    await Promise.all(notLoaded.map(key => loadExistingSegmentsForEpisode(key)));
  }

  const beforeCount = items.length;
  items = items.filter(item => !isAlreadyInIntroDB(item));
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

  let downloaded = 0;
  function downloadNext(index) {
    if (index >= files.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${items.length} entries`);
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
    items,
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
  if (state.submitInProgress) {
    toast('Submission in progress, please wait...');
    return;
  }

  const allMapped = state.allItems.map(({ _eid, ...rest }) => rest);
  const pendingItems = allMapped.filter(item => item.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length > 0) toast(`${pendingItems.length} timestamp(s) have no IMDb ID yet (IMDB_PENDING) and will be skipped.`);

  const episodeKeys = [...new Set(
    allMapped
      .filter(item => item.imdb_id && item.imdb_id !== 'IMDB_PENDING')
      .map(item => createEpisodeCacheKey(item.imdb_id, item.season, item.episode))
  )];
  const notLoaded = episodeKeys.filter(key => !(state.dedupCacheV2 && state.dedupCacheV2[key]));
  if (notLoaded.length > 0) {
    toast(`Checking IntroDB for existing segments (${notLoaded.length} episode(s))...`);
    await Promise.all(notLoaded.map(key => loadExistingSegmentsForEpisode(key)));
  }

  const items = allMapped.filter(item => item.imdb_id !== 'IMDB_PENDING' && !isAlreadyInIntroDB(item));
  const skipped = allMapped.length - items.length;
  if (!items.length) {
    toast('All timestamps already exist in IntroDB.');
    setIntrodbStatus('Nothing new to submit (all duplicates)');
    return;
  }

  const skipMessage = skipped > 0 ? ` (${skipped} already existed, skipped)` : '';
  const ids = [...new Set(items.map(item => item.imdb_id))].join(', ');
  if (!confirm(`Submit ${items.length} timestamp${items.length !== 1 ? 's' : ''} to IntroDB?${skipMessage}\nID(s): ${ids}`)) return;

  state.submitInProgress = true;
  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn(`Submitting 0/${items.length}...`);
  let sent = 0;

  function sendNext(index) {
    if (index >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('📡 Submit to IntroDB');
      toast(`IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      setIntrodbStatus(`${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      return;
    }

    const item = items[index];
    submitSegment(item, state.introdbApiKey).then(result => {
      sent++;
      if (result.success) {
        state.submitResults.ok++;
        const key = createEpisodeCacheKey(item.imdb_id, item.season, item.episode);
        if (!state.dedupCacheV2[key]) state.dedupCacheV2[key] = new Set();
        state.dedupCacheV2[key].add(item.segment_type);
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
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, createState(activeProviderConfig.name), { introdbApiKey });
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
      state.introdbApiKey = value;
      setIntrodbStatus('API key saved');
      toast('IntroDB API key saved');
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
  win.__segmentScraper = { getAll: () => state.allItems, state };
}
