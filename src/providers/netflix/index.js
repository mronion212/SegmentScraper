/**
 * Netflix provider entry point
 * Sets up network interception and initializes the Netflix-specific extraction
 */

import { state, createState } from '../../core/state.js';
import { processMetadata, setDbStatus, setIntrodbStatus, exportJSON, submitToIntroDB, clearData } from './extractor.js';
import { injectBtn, getNextEpBtn } from '../../ui/button.js';
import { setProviderName, openPanel, closePanel, updateCounters, updatePanelTitle, toast, updateImdbInput } from '../../ui/panel.js';
import { getProviderConfig } from '../../config/provider-config.js';
import { searchImdbByTitle, lookupImdbTitle, loadExistingSegments } from '../../core/network.js';

const PROVIDER_NAME = 'netflix';
const config = getProviderConfig(PROVIDER_NAME);
const BUTTON_IDLE_DELAY_MS = 3000;
let buttonHideTimer;

// Initialize state with provider name
Object.assign(state, createState(config.name));

// Set up panel callbacks and provider name on window object
setProviderName(PROVIDER_NAME);
window.nfePanelCallbacks = {
  onClose: closePanel,
  onExport: exportJSON,
  onSubmit: submitToIntroDB,
  onClear: clearData,
onImdbSet: () => {
    const v = document.getElementById('nfe-imdb-input').value.trim();
    if (!v) return;
    state.imdbId = v;
    state.allItems.forEach(item => { item.imdb_id = v; });
    state.dedupCacheV2 = {};
    setDbStatus(`ID saved: ${v}`);
    updateCounters();
    loadExistingSegments(v);
    lookupImdbTitle(v).then(result => {
      if (!result.success) return;
      state.showTitle = result.title;
      state.showYear = result.year ? String(result.year) : '';
      updatePanelTitle();
    });
  },
onImdbSearch: () => {
      const manual = document.getElementById('nfe-imdb-input').value.trim();
      const q = manual || state.showTitle;
      if (!q) { toast('No title detected yet.'); return; }
      state.dbSearchDone = false;
      state.dedupCacheV2 = {};
      searchImdbByTitle(q, state.showYear).then(result => {
        console.log('[NFE] Manual IMDb search result:', result);
        if (result.success) {
          state.imdbId = result.imdbId;
          state.allItems.forEach(i => { 
            if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = result.imdbId; 
          });
          updateImdbInput();
          setDbStatus(`Found: ${result.imdbId}`);
          updateCounters();
          loadExistingSegments(result.imdbId);
        } else {
          setDbStatus(`IMDb lookup failed: ${result.error}`);
        }
      }).catch(err => {
        console.error('[NFE] Manual IMDb search error:', err);
        setDbStatus('IMDb lookup error');
      });
    },
  onApikeySet: () => {
    const v = document.getElementById('nfe-apikey-input').value.trim();
    if (!v) {
      toast('Please enter an IntroDB API key.');
      return;
    }
    state.introdbApiKey = v;
    setIntrodbStatus('API key saved');
    toast('IntroDB API key saved');
  },
};

/**
 * Set up XHR and fetch interception for Netflix metadata
 */
function setupInterception() {
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const OriginalXHR = win.XMLHttpRequest;
  function InterceptedXHR() {
    const xhr = new OriginalXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) { 
      _url = url; 
      return origOpen(method, url, ...rest); 
    };
    const origSend = xhr.send.bind(xhr);
    xhr.send = function (...args) {
      if (_url && _url.includes('memberapi') && _url.includes('metadata')) {
        xhr.addEventListener('load', () => {
          try { 
            const d = JSON.parse(xhr.responseText); 
            if (d && d.video) processMetadata(d, PROVIDER_NAME); 
          } catch (_) {}
        });
      }
      return origSend(...args);
    };
    return xhr;
  }
  Object.setPrototypeOf(InterceptedXHR, OriginalXHR);
  InterceptedXHR.prototype = OriginalXHR.prototype;
  win.XMLHttpRequest = InterceptedXHR;

  const origFetch = win.fetch.bind(win);
  win.fetch = async function (input, init) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const resp = await origFetch(input, init);
    if (url.includes('memberapi') && url.includes('metadata')) {
      try { 
        const d = await resp.clone().json(); 
        if (d && d.video) processMetadata(d, PROVIDER_NAME); 
      } catch (_) {}
    }
    return resp;
  };
}

/**
 * Set up panel click-outside handler
 */
function setupPanelHandler() {
  document.addEventListener('click', e => {
    const panel = document.getElementById('nfe-panel');
    const btn = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(e.target) && !btn?.contains(e.target)) {
      closePanel();
    }
  }, true);
}

/**
 * Sync the panel with Netflix player controls.
 */
function syncVisibility() {
  const ctrl =
    document.querySelector('[data-uia="controls-standard"]') ||
    document.querySelector('[class*="PlayerControls"]') ||
    document.querySelector('.watch-video--bottom-controls-container');
  if (!ctrl) return;
  const visible = parseFloat(getComputedStyle(ctrl).opacity) > 0.05;
  if (!state.panelVisible) return;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  panel.style.opacity = visible ? '1' : '0';
  panel.style.pointerEvents = visible ? 'auto' : 'none';
}

function setButtonVisibility(visible) {
  const btn = document.getElementById('nfe-btn');
  if (!btn) return;
  btn.style.opacity = visible ? '0.85' : '0';
  btn.style.pointerEvents = visible ? 'auto' : 'none';
}

function resetButtonIdleTimer() {
  clearTimeout(buttonHideTimer);
  setButtonVisibility(true);
  buttonHideTimer = setTimeout(() => setButtonVisibility(false), BUTTON_IDLE_DELAY_MS);
}

/**
 * Main loop - inject button and sync on watch pages
 */
function mainLoop() {
  let lastPath = location.pathname;
  setInterval(() => {
    const inWatch = location.pathname.startsWith('/watch');
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      document.getElementById('nfe-btn')?.remove();
      if (!inWatch) { 
        document.getElementById('nfe-panel')?.remove(); 
        state.panelVisible = false; 
      }
    }
    if (inWatch) { 
      const buttonMissing = !document.getElementById('nfe-btn');
      injectBtn(PROVIDER_NAME, getNextEpBtn); 
      if (buttonMissing) resetButtonIdleTimer();
      syncVisibility(); 
    }
  }, 1000);
}

function setupControlVisibilityHandler() {
  document.addEventListener('mousemove', () => {
    resetButtonIdleTimer();
    syncVisibility();
    setTimeout(syncVisibility, 250);
  }, true);
}

// Initialize
setupInterception();
setupPanelHandler();
setupControlVisibilityHandler();
mainLoop();

// Debug helpers - exposed to unsafeWindow for console access
const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
win.__netflixTimestamps = {
  getAll: () => state.allItems,
  getShowId: () => state.showId,
  state,
};
