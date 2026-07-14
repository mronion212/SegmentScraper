/** Prime Video provider entry point. */

import { state, createState } from '../../core/state.js';
import { setupPrimeVideoInterception } from './extractor.js';
import { exportJSON, submitToIntroDB, clearData, setDbStatus, setIntrodbStatus } from '../netflix/extractor.js';
import { injectBtn, getNextEpBtn } from '../../ui/button.js';
import { setProviderName, openPanel, closePanel, updateCounters, toast, updateImdbInput, updatePanelTitle } from '../../ui/panel.js';
import { getProviderConfig } from '../../config/provider-config.js';
import { searchImdbByTitle, lookupImdbTitle, loadExistingSegments } from '../../core/network.js';

const PRIME_VIDEO_PROVIDER_NAME = 'prime-video';
const primeVideoConfig = getProviderConfig(PRIME_VIDEO_PROVIDER_NAME);

Object.assign(state, createState(primeVideoConfig.name), {
  currentSeason: 1,
  currentEpisode: 1,
  asinMap: new Map(),
  pendingByAsin: new Map(),
});

setProviderName(PRIME_VIDEO_PROVIDER_NAME);
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
      console.error('[PVE] Manual IMDb search error:', error);
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

function setupPrimeVideoPanelHandler() {
  document.addEventListener('click', event => {
    const panel = document.getElementById('nfe-panel');
    const button = document.getElementById('nfe-btn');
    if (panel && state.panelVisible && !panel.contains(event.target) && !button?.contains(event.target)) closePanel();
  }, true);
}

function startPrimeVideoMainLoop() {
  setInterval(() => injectBtn(PRIME_VIDEO_PROVIDER_NAME, getNextEpBtn), 1000);
}

setupPrimeVideoInterception();
setupPrimeVideoPanelHandler();
startPrimeVideoMainLoop();

const primeVideoWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
primeVideoWindow.__primeVideoTimestamps = {
  getAll: () => state.allItems,
  getAsinMap: () => state.asinMap,
  state,
};
