/**
 * Shared UI panel component
 * Creates a reusable panel with provider-configurable styling
 */

import { state } from '../core/state.js';
import { getProviderConfig, PANEL_COLORS } from '../config/provider-config.js';

// Default provider name
let currentProvider = 'netflix';
let panelReturnFocus = null;

/**
 * Set the current provider name
 */
export function setProviderName(name) {
  currentProvider = name;
}

function bindPanelCallback(element, callbackName, logMessage) {
  if (!element) return;
  element.addEventListener('click', () => {
    if (logMessage) console.log(logMessage);
    if (window.nfePanelCallbacks && window.nfePanelCallbacks[callbackName]) {
      window.nfePanelCallbacks[callbackName]();
    }
  });
}

function bindButtonClickOnEnter(input, getButton) {
  if (!input) return;
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const button = getButton();
    if (button) button.click();
  });
}

function setupPanelEventListeners() {
  const closeBtn = document.getElementById('nfe-close');
  const exportBtn = document.getElementById('nfe-export');
  const submitBtn = document.getElementById('nfe-submit');
  const clearBtn = document.getElementById('nfe-clear');
  const imdbSetBtn = document.getElementById('nfe-imdb-set');
  const imdbSearchBtn = document.getElementById('nfe-imdb-search');
  const imdbInput = document.getElementById('nfe-imdb-input');
  const apikeySetBtn = document.getElementById('nfe-apikey-set');
  const apikeyInput = document.getElementById('nfe-apikey-input');
  const tvdbSetBtn = document.getElementById('nfe-tvdb-set');
  const tvdbInputs = [document.getElementById('nfe-tvdb-apikey-input'), document.getElementById('nfe-tvdb-pin-input')];

  bindPanelCallback(closeBtn, 'onClose', '[NFE] Close button clicked');
  bindPanelCallback(exportBtn, 'onExport', '[NFE] Export button clicked');
  bindPanelCallback(document.getElementById('nfe-diagnostics'), 'onDiagnostics');
  bindPanelCallback(submitBtn, 'onSubmit', '[NFE] Submit button clicked');
  bindPanelCallback(clearBtn, 'onClear', '[NFE] Clear button clicked');
  bindPanelCallback(imdbSetBtn, 'onImdbSet', '[NFE] IMDB set button clicked');
  bindPanelCallback(imdbSearchBtn, 'onImdbSearch', '[NFE] IMDB search button clicked');
  bindButtonClickOnEnter(imdbInput, () => document.getElementById('nfe-imdb-set'));

  bindPanelCallback(apikeySetBtn, 'onApikeySet', '[NFE] API key set button clicked');
  bindButtonClickOnEnter(apikeyInput, () => document.getElementById('nfe-apikey-set'));

  bindPanelCallback(tvdbSetBtn, 'onTvdbSet');
  bindPanelCallback(document.getElementById('nfe-tmdb-set'), 'onTmdbSet');
  bindButtonClickOnEnter(document.getElementById('nfe-tmdb-input'), () => document.getElementById('nfe-tmdb-set'));
  tvdbInputs.filter(Boolean).forEach(input => bindButtonClickOnEnter(input, () => tvdbSetBtn));
}

/**
 * Create the UI panel with provider-specific styling
 * This function creates the panel and attaches all event handlers
 */
export function createPanel() {
  console.log('[NFE] createPanel called, currentProvider:', currentProvider);
  const config = getProviderConfig(currentProvider);
  if (!config) {
    console.error('[NFE] No config found for provider:', currentProvider);
    return;
  }
  const { colors: providerColors, branding, infoAccent, nameColor } = config;
  const colors = PANEL_COLORS;
  
  if (document.getElementById('nfe-panel')) {
    console.log('[NFE] Panel already exists');
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'nfe-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'SegmentScraper');
  panel.tabIndex = -1;
  panel.style.cssText = `
    position:fixed; z-index:2147483647; width:308px; max-width:calc(100vw - 40px);
    background:${colors.background}; border:1px solid ${colors.border}; border-radius:12px;
    padding:16px; color:${colors.text}; font-family:-apple-system,Arial,sans-serif;
    font-size:13px; line-height:normal; box-sizing:border-box; box-shadow:0 16px 48px rgba(0,0,0,0.85);
    transition:opacity 0.18s; user-select:none; display:none; opacity:0;
    max-height:calc(100dvh - 40px); overflow:auto; overscroll-behavior:contain;
    scrollbar-width:thin; scrollbar-color:#555 #181818;
  `;

  if (state.updateRequired) {
    panel.innerHTML = `
      <style>
        #nfe-panel, #nfe-panel * { box-sizing:border-box; font-family:-apple-system,Arial,sans-serif; text-shadow:none; }
      </style>
      <div style="font-size:15px;font-weight:800;color:#ff6b6b;margin-bottom:10px">Update required</div>
      <div style="background:${colors.panelBg};border:1px solid #7f3030;border-radius:9px;padding:12px;margin-bottom:10px;color:${colors.textSecondary};font-size:12px;line-height:1.5">
        A newer SegmentScraper version is available. Version <strong style="color:${colors.text}">${state.latestVersion}</strong>
        must be installed before you can continue.
      </div>
      <a id="nfe-update-link" href="${state.updateUrl}" target="_blank" rel="noopener noreferrer"
        style="display:block;width:100%;background:#d83b3b;border-radius:8px;color:#fff;padding:11px;text-align:center;text-decoration:none;font-size:13px;font-weight:800">
        Update to v${state.latestVersion}
      </a>
      <div style="font-size:10px;color:${colors.textMuted};margin-top:9px;line-height:1.4;text-align:center">
        Installed: v${state.currentVersion}. Confirm the installation and then reload this page.
      </div>
    `;

    (document.fullscreenElement || document.body).appendChild(panel);
    panel.addEventListener('click', event => event.stopPropagation());
    panel.addEventListener('mousedown', event => event.stopPropagation());
    console.warn(`[NFE] Update required: v${state.currentVersion} -> v${state.latestVersion}`);
    return;
  }

  panel.innerHTML = `
    <style>
      #nfe-panel, #nfe-panel * {
        box-sizing:border-box; font-family:-apple-system,Arial,sans-serif;
        font-style:normal; text-shadow:none;
      }
      #nfe-panel button, #nfe-panel input {
        min-width:0; margin:0; font-family:-apple-system,Arial,sans-serif;
        font-style:normal; line-height:normal; letter-spacing:normal; text-transform:none;
        appearance:none; -webkit-appearance:none;
      }
      #nfe-panel button, #nfe-panel input { min-height:0; }
      #nfe-panel :focus-visible { outline:2px solid white; outline-offset:2px; }
      #nfe-panel summary { cursor:pointer; padding:8px 0; font-size:12px; font-weight:700; }
    </style>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700;color:${nameColor}">${config.name} ${branding.title}</span>
      <button id="nfe-close" aria-label="Close SegmentScraper" style="background:none;border:none;color:${colors.textMuted};font-size:18px;cursor:pointer;line-height:1;padding:0;transition:color 0.15s"
        onmouseenter="this.style.color='${colors.text}'" onmouseleave="this.style.color='${colors.textMuted}'">✕</button>
    </div>

    <div id="nfe-title-display" style="color:${colors.textSecondary};font-size:11px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:13px"></div>

    <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
      <div id="nfe-imdb-status" style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:7px">${state.mediaType === 'movie' ? 'Movie' : 'TV'} · IMDb ID: ${state.imdbId || 'Not set'}</div>
      <div style="display:flex;gap:4px">
        <input id="nfe-imdb-input" aria-label="IMDb ID or search title" type="text" placeholder="ID (e.g. tt123456)..." value="${state.imdbId}"
          style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                 padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
          onfocus="this.style.borderColor='${colors.accent}'" onblur="this.style.borderColor='#303030'"/>
        <button id="nfe-imdb-search" title="Search by title on IMDb"
          style="background:#242424;border:1px solid #303030;border-radius:6px;color:#bbb;
                 padding:6px 8px;cursor:pointer;font-size:12px;transition:background 0.15s"
          onmouseenter="this.style.background='#2e2e2e'" onmouseleave="this.style.background='#242424'">Search</button>
        <button id="nfe-imdb-set"
          style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                 padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
          onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">OK</button>
      </div>
    </div>

    <div id="nfe-imdb-feedback" role="status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:8px;line-height:1.4"></div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-ts"    style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div id="nfe-cnt-segments-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Segments</div>
      </div>
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-req"   style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div id="nfe-cnt-series-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Series</div>
      </div>
      <div style="flex:1;background:${colors.panelBg};border-radius:8px;padding:8px;text-align:center">
        <div id="nfe-cnt-files" style="font-size:20px;font-weight:700;color:#fff;line-height:1">0</div>
        <div id="nfe-cnt-files-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Files</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
      <div style="flex:1;height:1px;background:${colors.border}"></div>
      <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">MANUAL / BULK UPLOAD</span>
      <div style="flex:1;height:1px;background:${colors.border}"></div>
    </div>

    <div style="border-left:2px solid ${infoAccent};padding:6px 9px;margin-bottom:8px;font-size:11px;color:${colors.textMuted};line-height:1.4;background:${colors.panelBg};border-radius:0 7px 7px 0">
      ${config.captureHint}
    </div>

    <button id="nfe-export"
      style="width:100%;background:${providerColors.primary};border:none;border-radius:8px;color:#fff;
             padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
             transition:background 0.15s"
      onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">
      Show timestamps
    </button>
    ${currentProvider === 'skyshowtime' ? `<button id="nfe-diagnostics" style="width:100%;padding:8px;margin-bottom:6px;border:1px solid ${colors.border};border-radius:8px;background:${colors.panelBg};color:#fff;cursor:pointer">Download movie diagnostics</button><div style="font-size:11px;color:${colors.textMuted};margin-bottom:8px">Very short movie credits are held for review. Missing scene markers do not confirm that there is no extra scene.</div>` : ''}

     <details id="nfe-settings"><summary>API settings</summary>
     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">TVDB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">Your TVDB API Key</div>
       <input id="nfe-tvdb-apikey-input" aria-label="TheTVDB API key" type="password" placeholder="Enter your TVDB API key..."
         style="width:100%;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                padding:6px 8px;font-size:12px;outline:none;margin-bottom:5px"/>
       <div style="display:flex;gap:4px">
         <input id="nfe-tvdb-pin-input" aria-label="TheTVDB subscriber PIN" type="password" placeholder="Subscriber PIN (optional)"
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none"/>
         <button id="nfe-tvdb-set"
           style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700">Save</button>
       </div>
       <div id="nfe-tvdb-status" style="font-size:11px;color:${colors.textSecondary};margin-top:6px;line-height:1.4;${state.tvdbApiKey ? '' : 'display:none;'}">${state.tvdbApiKey ? 'TVDB credentials saved locally' : ''}</div>
       <div style="font-size:9px;color:${colors.textMuted};margin-top:5px">Episode metadata provided by <a href="https://thetvdb.com" target="_blank" rel="noopener noreferrer" style="color:${colors.textSecondary}">TheTVDB</a>.</div>
     </div>

     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">INTRODB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">API Key</div>
       <div style="display:flex;gap:4px">
         <input id="nfe-apikey-input" aria-label="IntroDB API key" type="password" placeholder="Enter your IntroDB API key..."
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
           onfocus="this.style.borderColor='${colors.accent}'" onblur="this.style.borderColor='#303030'"/>
         <button id="nfe-apikey-set"
           style="background:${providerColors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
           onmouseenter="this.style.background='${providerColors.primaryDark}'" onmouseleave="this.style.background='${providerColors.primary}'">Save</button>
       </div>
     </div>

     </details>
     <div id="nfe-session-status" role="status" style="font-size:11px;color:#aaa;margin:8px 0;line-height:1.4"></div>
     <div id="nfe-introdb-status" role="status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:6px;line-height:1.4;text-align:center;${state.introdbApiKey ? '' : 'display:none;'}">${state.introdbApiKey ? 'API key saved locally' : ''}</div>

     <div style="margin-bottom:10px;font-size:11px;color:${colors.textSecondary}">
       <label for="nfe-tmdb-input">TMDB API Read Access Token (movie scene check)</label>
       <div style="display:flex;gap:4px;margin:5px 0">
         <input id="nfe-tmdb-input" type="password" autocomplete="off" placeholder="Paste token; blank clears it"
           style="min-width:0;flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;padding:6px 8px"/>
         <button id="nfe-tmdb-set" style="background:${providerColors.primary};border:0;border-radius:6px;color:#fff;padding:6px 10px;cursor:pointer">Save</button>
       </div>
       <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" style="color:${colors.textSecondary}">Get a TMDB token</a> · Saved locally. Movie export/upload requires a successful check. Missing keywords do not prove scene absence.
       <div>This product uses the TMDB API but is not endorsed or certified by TMDB.</div>
     </div>
     <button id="nfe-submit"
       style="width:100%;background:${providerColors.secondary};border:none;border-radius:8px;color:#fff;
              padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
              transition:background 0.15s"
       onmouseenter="this.style.background='${providerColors.secondaryDark}'" onmouseleave="this.style.background='${providerColors.secondary}'">
       Submit to IntroDB
     </button>

    <button id="nfe-clear"
      style="width:100%;margin-top:12px;background:transparent;border:1px solid #222;border-radius:8px;
             color:${colors.textMuted};padding:7px;cursor:pointer;font-size:12px;transition:all 0.15s"
      onmouseenter="this.style.borderColor='#444';this.style.color='#888'"
      onmouseleave="this.style.borderColor='#222';this.style.color='${colors.textMuted}'">
      Clear data
    </button>
  `;

  document.body.appendChild(panel);
  console.log('[NFE] Panel created and appended to body');

  setupPanelEventListeners();
  const feedback = document.getElementById('nfe-imdb-feedback');
  if (feedback) feedback.textContent = state.dbStatusMsg || '';

  panel.addEventListener('click', e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
  });
}

/**
 * Keep the panel inside the lower-right viewport corner.
 */
export function positionPanel(panel) {
  panel.style.right = '20px';
  panel.style.bottom = '20px';
  panel.style.left = 'auto';
  panel.style.transform = 'none';
}

/**
 * Toggle panel visibility
 */
export function togglePanel() {
  console.log('[NFE] togglePanel called, panelVisible:', state.panelVisible);
  if (state.panelVisible) {
    closePanel();
  } else {
    openPanel();
  }
}

/**
 * Open the panel
 */
export function openPanel() {
  console.log('[NFE] openPanel called');
  createPanel();
  const panel = document.getElementById('nfe-panel');
  if (!panel) {
    console.error('[NFE] Panel not found after createPanel');
    return;
  }
  console.log('[NFE] Panel found, positioning and showing');
  panelReturnFocus = document.activeElement;
  positionPanel(panel);
  panel.style.pointerEvents = 'auto';
  document.getElementById('nfe-btn')?.setAttribute('aria-expanded', 'true');
  state.panelVisible = true;
  panel.style.display = 'block';
  panel.focus();
  requestAnimationFrame(() => (panel.style.opacity = '1'));
  updateCounters();
  updatePanelTitle();
}

/**
 * Close the panel
 */
export function closePanel() {
  if (state.updateRequired) return;
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  state.panelVisible = false;
  document.getElementById('nfe-btn')?.setAttribute('aria-expanded', 'false');
  if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';
  setTimeout(() => {
    if (!state.panelVisible) {
      panel.style.display = 'none';
      panel.style.pointerEvents = 'auto';
    }
  }, 200);
}

/** Replace an existing panel with the non-dismissible required-update screen. */
export function showRequiredUpdate() {
  document.getElementById('nfe-panel')?.remove();
  state.panelVisible = false;
  openPanel();
}

/**
 * Update counter displays
 */
export function updateCounters() {
  const $ = id => document.getElementById(id);
  const session = $('nfe-session-status');
  if (session) session.textContent = state.sessionStorageError
    ? 'Session recovery is unavailable. Download your data before reloading.'
    : state.sessionSavedAt ? 'Session saved in this tab: ' + new Date(state.sessionSavedAt).toLocaleString('en-GB') : 'Captured data is saved in this tab for recovery after reload.';
  const ts = $('nfe-cnt-ts');
  if (ts) ts.textContent = state.allItems.length;
  const segmentsLabel = $('nfe-cnt-segments-label');
  if (segmentsLabel) segmentsLabel.textContent = state.allItems.length === 1 ? 'Segment' : 'Segments';
  
  const rq = $('nfe-cnt-req');
  if (rq) rq.textContent = state.showIds.size;
  const mediaLabel = $('nfe-cnt-series-label');
  if (mediaLabel) {
    const hasMovie = state.allItems.some(item => String(item?.media_type || item?.mediaType || item?._mediaType || '').toLowerCase() === 'movie');
    mediaLabel.textContent = hasMovie ? 'Media' : 'Series';
  }
  
  const fl = $('nfe-cnt-files');
  if (fl) {
    const groups = new Map();
    for (const it of state.allItems) {
      const key = it.imdb_id || 'no_id';
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    let fileTotal = 0;
    for (const count of groups.values()) {
      fileTotal += Math.max(Math.ceil(count / 100), state.allItems.length ? 1 : 0);
    }
    fl.textContent = fileTotal;
    const filesLabel = $('nfe-cnt-files-label');
    if (filesLabel) filesLabel.textContent = fileTotal === 1 ? 'File' : 'Files';
  }
}

/**
 * Update the panel title with show information
 */
export function updatePanelTitle() {
  const el = document.getElementById('nfe-title-display');
  if (!el) return;
  el.textContent = state.showTitle 
    ? `${state.showTitle}${state.showYear ? ` (${state.showYear})` : ''}`
    : '';
}

/**
 * Update the IMDb input field with current imdbId
 */
export function updateImdbInput() {
  const inp = document.getElementById('nfe-imdb-input');
  if (inp) inp.value = state.imdbId || '';
}

/**
 * Update the API key input field with current API key
 */
export function updateApikeyInput() {
  const inp = document.getElementById('nfe-apikey-input');
  if (inp) inp.value = '';
}

/**
 * Show a toast notification
 */
export function toast(msg) {
  console.log('[NFE]', msg);
  document.getElementById('nfe-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'nfe-toast';
  t.textContent = msg;
  t.style.cssText = `
    position:fixed; top:18px; left:50%; transform:translateX(-50%);
    background:rgba(12,12,12,0.96); color:#fff; border:1px solid #2a2a2a; border-radius:9px;
    padding:9px 18px; font-size:12px; font-family:-apple-system,Arial,sans-serif;
    z-index:2147483647; box-shadow:0 4px 20px rgba(0,0,0,0.7);
    pointer-events:none; transition:opacity 0.3s;
  `;
  t.setAttribute('role', 'status');
  (document.fullscreenElement || document.body).appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

/**
 * Show the export data in a modal before files are downloaded.
 * The preview deliberately uses textContent so captured metadata cannot inject HTML.
 */
export function showExportPreview(view) {
  document.getElementById('nfe-export-preview')?.remove();

  const { colors: providerColors, name: providerName } = getProviderConfig(currentProvider);
  const colors = PANEL_COLORS;
  const overlay = document.createElement('div');
  overlay.id = 'nfe-export-preview';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center;
    justify-content:center; padding:24px; background:rgba(0,0,0,.72); box-sizing:border-box;
  `;

  const dialog = document.createElement('section');
  dialog.style.cssText = `
    width:min(760px, 100%); max-height:calc(100vh - 48px); display:flex; flex-direction:column;
    padding:18px; border:1px solid ${colors.border}; border-radius:12px; background:${colors.background};
    color:${colors.text}; font:13px/normal -apple-system,Arial,sans-serif; box-sizing:border-box;
    box-shadow:0 16px 48px rgba(0,0,0,.85);
  `;

  const heading = document.createElement('h2');
  heading.textContent = view.mode === 'submit' ? 'Review IntroDB upload' : `${providerName} timestamps`;
  heading.style.cssText = `margin:0 0 6px; color:${providerColors.primary}; font:700 16px/normal -apple-system,Arial,sans-serif;`;
  const summary = document.createElement('p');
  summary.style.cssText = `margin:0 0 12px; color:${colors.textSecondary}; font:13px/normal -apple-system,Arial,sans-serif;`;
  const preview = document.createElement('div');
  preview.style.cssText = `
    overflow:auto; flex:1; min-height:180px; margin:0 0 14px; padding:12px; border-radius:8px;
    background:${colors.panelBg}; color:${colors.text}; box-sizing:border-box;
    font:11px/normal ui-monospace,Consolas,monospace; white-space:pre-wrap;
  `;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
  const cancel = document.createElement('button');
  cancel.textContent = 'Close';
  cancel.style.cssText = 'box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; font:13px/normal -apple-system,Arial,sans-serif; cursor:pointer;';
  const confirm = document.createElement('button');
  confirm.textContent = view.mode === 'submit' ? 'Upload to IntroDB' : 'Download JSON';
  confirm.style.cssText = `box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; font:700 13px/normal -apple-system,Arial,sans-serif; cursor:pointer;`;
  const upload = document.createElement('button');
  upload.textContent = 'Upload to IntroDB';
  upload.style.cssText = `box-sizing:border-box; appearance:none; margin:0; padding:8px 12px; border:0; border-radius:6px; background:${providerColors.primary}; color:#fff; font:700 13px/normal -apple-system,Arial,sans-serif; cursor:pointer;`;

  const clock = value => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const ms = Math.round(Number(value) * 1000);
    const seconds = Math.floor(ms / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const humanClock = value => {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const ms = Math.round(Number(value) * 1000);
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}s`;
  };
  const rangeText = range => {
    const start = range?.start_sec ?? range?.startSec;
    const end = range?.end_sec ?? range?.endSec;
    return `${clock(start)} → ${clock(end)}\n${humanClock(start)} → ${humanClock(end)}`;
  };
  const mediaIsMovie = item => item?.is_movie === true || String(item?.media_type || item?.mediaType || item?._mediaType || '').toLowerCase() === 'movie';
  const makeColumn = (title, ranges, emptyText, accent) => {
    const column = document.createElement('div');
    column.style.cssText = `min-width:0; padding:10px; border:1px solid ${colors.border}; border-radius:8px; background:${colors.background};`;
    const heading = document.createElement('strong');
    heading.textContent = title;
    heading.style.cssText = `display:block; margin-bottom:7px; color:${accent}; font:700 12px/normal -apple-system,Arial,sans-serif;`;
    column.append(heading);
    if (!ranges.length) {
      const empty = document.createElement('div');
      empty.textContent = emptyText;
      empty.style.cssText = `color:${colors.textMuted}; font:11px/1.45 -apple-system,Arial,sans-serif;`;
      column.append(empty);
      return column;
    }
    for (const range of ranges) {
      const type = document.createElement('div');
      type.textContent = range.segment_type || 'timestamp';
      type.style.cssText = 'margin-bottom:3px; color:#fff; font-weight:700;';
      const times = document.createElement('div');
      times.textContent = rangeText(range);
      times.style.cssText = 'white-space:pre-line; color:#ddd; line-height:1.55;';
      column.append(type, times);
    }
    return column;
  };
  let approvalChecked = false;
  const update = next => {
    view = next;
    const rows = view.rows || [];
    summary.textContent = `${rows.length} timestamps · ${rows.filter(row => row.status === 'NEW').length} NEW · ${view.duplicateCount} in IntroDB · ${rows.filter(row => row.status === 'Unavailable').length} unavailable. ${view.message || ''}`;
    preview.replaceChildren();
    for (const row of rows) {
      const item = row.item;
      const entry = document.createElement('div');
      entry.style.cssText = `padding:10px 0; border-bottom:1px solid ${colors.border}; line-height:1.6;`;
      const label = document.createElement('strong');
      label.textContent = row.status;
      label.style.color = row.status === 'NEW' ? '#69d89b' : colors.textSecondary;
      const meta = document.createElement('div');
      const movie = mediaIsMovie(item);
      const itemLabel = movie ? 'Movie' : item.season != null && item.episode != null ? `S${item.season}E${item.episode}` : 'TV episode';
      meta.textContent = `${item.imdb_id || 'IMDb pending'} · ${itemLabel}${item._episodeTitle ? ` · ${item._episodeTitle}` : ''}`;
      const canonicalSeason = row.canonical?.season;
      const canonicalEpisode = row.canonical?.episode;
      if (!movie && canonicalSeason != null && canonicalEpisode != null) meta.textContent += ` · TVDB S${canonicalSeason}E${canonicalEpisode}`;
      if (row.reason) meta.textContent += `\n${row.reason}`;
      meta.style.cssText = 'margin-top:4px; white-space:pre-line; color:#ddd; font:11px/1.5 ui-monospace,Consolas,monospace;';
      const currentRanges = row.existingSegments
        ? row.existingSegments
        : (row.existingRanges || []).map(range => ({ segment_type: item.segment_type, start_sec: range.startSec, end_sec: range.endSec }));
      const comparison = document.createElement('div');
      comparison.style.cssText = 'display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:9px;';
      comparison.append(
        makeColumn('Scraper', [{ segment_type: item.segment_type, start_sec: item.start_sec, end_sec: item.end_sec }], 'No scraper timestamp', providerColors.primary),
        makeColumn('IntroDB', currentRanges, row.existingSegments ? 'No current timestamp returned' : 'IntroDB check unavailable', '#e4b968'),
      );
      entry.append(label, meta, comparison);
      preview.append(entry);
    }
    const needsUploadApproval = Boolean(view.requiresApproval || view.onUpload);
    if (needsUploadApproval) {
      const approval = document.createElement('label');
      approval.style.cssText = `display:flex;gap:8px;align-items:flex-start;margin-top:12px;padding:10px;border:1px solid ${colors.border};border-radius:8px;color:${colors.textSecondary};font:12px/1.5 -apple-system,Arial,sans-serif;`;
      const approvalInput = document.createElement('input');
      approvalInput.type = 'checkbox';
      approvalInput.checked = approvalChecked;
      approvalInput.style.cssText = 'margin:2px 0 0;flex:0 0 auto;';
      approvalInput.addEventListener('change', () => { approvalChecked = approvalInput.checked; update(view); });
      approval.append(approvalInput, document.createTextNode(view.approvalLabel || 'I compared every Scraper timestamp with the current IntroDB timestamp(s), checked the exact video, and approve this upload.'));
      preview.append(approval);
    }
    confirm.hidden = typeof view.onConfirm !== 'function';
    confirm.disabled = Boolean(view.checking || !(view.items || []).length || typeof view.onConfirm !== 'function' || (view.mode === 'submit' && view.requiresApproval && !approvalChecked));
    confirm.style.opacity = confirm.disabled ? '.45' : '1';
    confirm.style.cursor = confirm.disabled ? 'not-allowed' : 'pointer';
    confirm.textContent = view.checking
      ? 'Checking…'
      : view.mode === 'submit' ? `Upload to IntroDB (${view.items.length})` : `Download JSON (${view.fileCount})`;
    upload.hidden = typeof view.onUpload !== 'function';
    upload.disabled = Boolean(view.checking || !(view.uploadItems || []).length || !view.onUpload || !approvalChecked);
    upload.style.opacity = upload.disabled ? '.45' : '1';
    upload.style.cursor = upload.disabled ? 'not-allowed' : 'pointer';
    upload.textContent = `Upload to IntroDB (${(view.uploadItems || []).length})`;
  };
  update(view);

  const previousFocus = document.activeElement;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Show timestamps');
  const close = (cancelled = true) => {
    if (!overlay.isConnected) return;
    overlay.remove();
    if (cancelled && view.onCancel) view.onCancel();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const focusables = [cancel, confirm, upload].filter(button => !button.hidden && !button.disabled);
      const currentIndex = focusables.indexOf(document.activeElement);
      focusables[(currentIndex + 1) % focusables.length]?.focus();
    }
  });
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  confirm.addEventListener('click', () => { if (!confirm.disabled) { const onConfirm = view.onConfirm; close(false); onConfirm(); } });
  upload.addEventListener('click', () => { if (!upload.disabled) { const onUpload = view.onUpload; close(false); onUpload(); } });
  actions.append(cancel, confirm, upload);
  dialog.append(heading, summary, preview, actions);
  overlay.append(dialog);
  overlay.addEventListener('click', event => event.stopPropagation());
  (document.fullscreenElement || document.body).append(overlay);
  cancel.focus();
  return update;
}
