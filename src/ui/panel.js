/**
 * Shared UI panel component
 * Creates a reusable panel with provider-configurable styling
 */

import { state } from '../core/state.js';
import { getProviderConfig } from '../config/provider-config.js';

// Default provider name
let currentProvider = 'netflix';

/**
 * Set the current provider name
 */
export function setProviderName(name) {
  currentProvider = name;
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
  const { colors, branding } = config;
  
  if (document.getElementById('nfe-panel')) {
    console.log('[NFE] Panel already exists');
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'nfe-panel';
  panel.style.cssText = `
    position:fixed; z-index:2147483647; width:308px; max-width:calc(100vw - 40px);
    background:${colors.background}; border:1px solid ${colors.border}; border-radius:12px;
    padding:16px; color:${colors.text}; font-family:-apple-system,Arial,sans-serif;
    font-size:13px; box-shadow:0 16px 48px rgba(0,0,0,0.85);
    transition:opacity 0.18s; user-select:none; display:none; opacity:0;
  `;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700;color:${colors.primary}">${branding.icon} ${config.name} ${branding.title}</span>
      <button id="nfe-close" style="background:none;border:none;color:${colors.textMuted};font-size:18px;cursor:pointer;line-height:1;padding:0;transition:color 0.15s"
        onmouseenter="this.style.color='${colors.text}'" onmouseleave="this.style.color='${colors.textMuted}'">✕</button>
    </div>

    <div id="nfe-title-display" style="color:${colors.textSecondary};font-size:11px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:13px"></div>

    <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
      <div id="nfe-imdb-status" style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:7px">IMDb ID: ${state.imdbId || 'Not set'}</div>
      <div style="display:flex;gap:4px">
        <input id="nfe-imdb-input" type="text" placeholder="ID (e.g. tt123456)..." value="${state.imdbId}"
          style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                 padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
          onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='#303030'"/>
        <button id="nfe-imdb-search" title="Search by title on IMDb"
          style="background:#242424;border:1px solid #303030;border-radius:6px;color:#bbb;
                 padding:6px 8px;cursor:pointer;font-size:12px;transition:background 0.15s"
          onmouseenter="this.style.background='#2e2e2e'" onmouseleave="this.style.background='#242424'">🔍</button>
        <button id="nfe-imdb-set"
          style="background:${colors.primary};border:none;border-radius:6px;color:#fff;
                 padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
          onmouseenter="this.style.background='${colors.primaryDark}'" onmouseleave="this.style.background='${colors.primary}'">OK</button>
      </div>
    </div>

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
        <div id="nfe-cnt-files" style="font-size:20px;font-weight:700;color:${colors.primary};line-height:1">0</div>
        <div id="nfe-cnt-files-label" style="font-size:9px;color:${colors.textMuted};margin-top:3px;text-transform:uppercase;letter-spacing:0.4px">Files</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
      <div style="flex:1;height:1px;background:${colors.border}"></div>
      <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">MANUAL / BULK UPLOAD</span>
      <div style="flex:1;height:1px;background:${colors.border}"></div>
    </div>

    <div style="border-left:2px solid ${colors.primary};padding:6px 9px;margin-bottom:8px;font-size:11px;color:${colors.textMuted};line-height:1.4;background:${colors.panelBg};border-radius:0 7px 7px 0">
      ${config.captureHint}
    </div>

    <button id="nfe-export"
      style="width:100%;background:${colors.primary};border:none;border-radius:8px;color:#fff;
             padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
             transition:background 0.15s"
      onmouseenter="this.style.background='${colors.primaryDark}'" onmouseleave="this.style.background='${colors.primary}'">
      📥 Download JSON(s)
    </button>

     <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
       <div style="flex:1;height:1px;background:#222"></div>
       <span style="font-size:10px;color:${colors.textMuted};font-weight:600;letter-spacing:0.5px">INTRODB</span>
       <div style="flex:1;height:1px;background:#222"></div>
     </div>

     <div style="background:${colors.panelBg};border-radius:9px;padding:10px;margin-bottom:8px">
       <div style="font-size:9px;color:${colors.textMuted};font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:5px">API Key</div>
       <div style="display:flex;gap:4px">
         <input id="nfe-apikey-input" type="password" placeholder="Enter your IntroDB API key..." value="${state.introdbApiKey}"
           style="flex:1;background:#242424;border:1px solid #303030;border-radius:6px;color:#fff;
                  padding:6px 8px;font-size:12px;outline:none;transition:border-color 0.15s"
           onfocus="this.style.borderColor='${colors.primary}'" onblur="this.style.borderColor='#303030'"/>
         <button id="nfe-apikey-set"
           style="background:${colors.primary};border:none;border-radius:6px;color:#fff;
                  padding:6px 10px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s"
           onmouseenter="this.style.background='${colors.primaryDark}'" onmouseleave="this.style.background='${colors.primary}'">Save</button>
       </div>
     </div>

     <div id="nfe-introdb-status" style="font-size:11px;color:${colors.textSecondary};margin-bottom:6px;line-height:1.4;text-align:center;${state.introdbApiKey ? '' : 'display:none;'}">${state.introdbApiKey ? 'API key saved' : ''}</div>

     <button id="nfe-submit"
       style="width:100%;background:${colors.secondary};border:none;border-radius:8px;color:#fff;
              padding:10px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:6px;
              transition:background 0.15s"
       onmouseenter="this.style.background='${colors.secondaryDark}'" onmouseleave="this.style.background='${colors.secondary}'">
       📡 Submit to IntroDB
     </button>

    <button id="nfe-clear"
      style="width:100%;margin-top:12px;background:transparent;border:1px solid #222;border-radius:8px;
             color:${colors.textMuted};padding:7px;cursor:pointer;font-size:12px;transition:all 0.15s"
      onmouseenter="this.style.borderColor='#444';this.style.color='#888'"
      onmouseleave="this.style.borderColor='#222';this.style.color='${colors.textMuted}'">
      🗑️ Clear data
    </button>
  `;

  document.body.appendChild(panel);
  console.log('[NFE] Panel created and appended to body');

  // Attach event listeners - use window.nfePanelCallbacks
  const setupEventListeners = () => {
    const closeBtn = document.getElementById('nfe-close');
    const exportBtn = document.getElementById('nfe-export');
    const submitBtn = document.getElementById('nfe-submit');
    const clearBtn = document.getElementById('nfe-clear');
    const imdbSetBtn = document.getElementById('nfe-imdb-set');
    const imdbSearchBtn = document.getElementById('nfe-imdb-search');
    const imdbInput = document.getElementById('nfe-imdb-input');
    const apikeySetBtn = document.getElementById('nfe-apikey-set');
    const apikeyInput = document.getElementById('nfe-apikey-input');
    
    if (closeBtn) closeBtn.addEventListener('click', () => {
      console.log('[NFE] Close button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onClose) {
        window.nfePanelCallbacks.onClose();
      }
    });
    if (exportBtn) exportBtn.addEventListener('click', () => {
      console.log('[NFE] Export button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onExport) {
        window.nfePanelCallbacks.onExport();
      }
    });
    if (submitBtn) submitBtn.addEventListener('click', () => {
      console.log('[NFE] Submit button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onSubmit) {
        window.nfePanelCallbacks.onSubmit();
      }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      console.log('[NFE] Clear button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onClear) {
        window.nfePanelCallbacks.onClear();
      }
    });
    if (imdbSetBtn) imdbSetBtn.addEventListener('click', () => {
      console.log('[NFE] IMDB set button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onImdbSet) {
        window.nfePanelCallbacks.onImdbSet();
      }
    });
    if (imdbSearchBtn) imdbSearchBtn.addEventListener('click', () => {
      console.log('[NFE] IMDB search button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onImdbSearch) {
        window.nfePanelCallbacks.onImdbSearch();
      }
    });
    if (imdbInput) imdbInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const imdbSetBtn = document.getElementById('nfe-imdb-set');
        if (imdbSetBtn) imdbSetBtn.click();
      }
    });
    if (apikeySetBtn) apikeySetBtn.addEventListener('click', () => {
      console.log('[NFE] API key set button clicked');
      if (window.nfePanelCallbacks && window.nfePanelCallbacks.onApikeySet) {
        window.nfePanelCallbacks.onApikeySet();
      }
    });
    if (apikeyInput) apikeyInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const apikeySetBtn = document.getElementById('nfe-apikey-set');
        if (apikeySetBtn) apikeySetBtn.click();
      }
    });
  };
  
  setupEventListeners();

  panel.addEventListener('click', e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => e.stopPropagation());
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
  positionPanel(panel);
  state.panelVisible = true;
  panel.style.display = 'block';
  requestAnimationFrame(() => (panel.style.opacity = '1'));
  updateCounters();
  updatePanelTitle();
}

/**
 * Close the panel
 */
export function closePanel() {
  const panel = document.getElementById('nfe-panel');
  if (!panel) return;
  state.panelVisible = false;
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';
  setTimeout(() => {
    if (!state.panelVisible) {
      panel.style.display = 'none';
      panel.style.pointerEvents = 'auto';
    }
  }, 200);
}

/**
 * Update counter displays
 */
export function updateCounters() {
  const $ = id => document.getElementById(id);
  const ts = $('nfe-cnt-ts');
  if (ts) ts.textContent = state.allItems.length;
  const segmentsLabel = $('nfe-cnt-segments-label');
  if (segmentsLabel) segmentsLabel.textContent = state.allItems.length === 1 ? 'Segment' : 'Segments';
  
  const rq = $('nfe-cnt-req');
  if (rq) rq.textContent = state.showIds.size;
  
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
    ? `📺 ${state.showTitle}${state.showYear ? ` (${state.showYear})` : ''}` 
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
  if (inp) inp.value = state.introdbApiKey || '';
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
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

/**
 * Show the export data in a modal before files are downloaded.
 * The preview deliberately uses textContent so captured metadata cannot inject HTML.
 */
export function showExportPreview({ items, fileCount, duplicateCount, onConfirm }) {
  document.getElementById('nfe-export-preview')?.remove();

  const { colors } = getProviderConfig(currentProvider);
  const overlay = document.createElement('div');
  overlay.id = 'nfe-export-preview';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center;
    justify-content:center; padding:24px; background:rgba(0,0,0,.72);
  `;

  const dialog = document.createElement('section');
  dialog.style.cssText = `
    width:min(760px, 100%); max-height:calc(100vh - 48px); display:flex; flex-direction:column;
    padding:18px; border:1px solid ${colors.border}; border-radius:12px; background:${colors.background};
    color:${colors.text}; font:13px -apple-system,Arial,sans-serif; box-shadow:0 16px 48px rgba(0,0,0,.85);
  `;

  const heading = document.createElement('h2');
  heading.textContent = 'Controleer JSON-export';
  heading.style.cssText = `margin:0 0 6px; color:${colors.primary}; font-size:16px;`;
  const summary = document.createElement('p');
  summary.textContent = `${items.length} timestamps in ${fileCount} bestand(en)${duplicateCount ? `; ${duplicateCount} duplicaten uitgesloten` : ''}.`;
  summary.style.cssText = `margin:0 0 12px; color:${colors.textSecondary};`;
  const preview = document.createElement('pre');
  preview.textContent = JSON.stringify({ items }, null, 2);
  preview.style.cssText = `
    overflow:auto; flex:1; min-height:180px; margin:0 0 14px; padding:12px; border-radius:8px;
    background:${colors.panelBg}; color:${colors.text}; font:11px ui-monospace,Consolas,monospace; white-space:pre-wrap;
  `;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
  const cancel = document.createElement('button');
  cancel.textContent = 'Annuleren';
  cancel.style.cssText = 'padding:8px 12px; border:1px solid #444; border-radius:6px; background:#242424; color:#fff; cursor:pointer;';
  const confirm = document.createElement('button');
  confirm.textContent = 'Download JSON';
  confirm.style.cssText = `padding:8px 12px; border:0; border-radius:6px; background:${colors.primary}; color:#fff; font-weight:700; cursor:pointer;`;

  const close = () => overlay.remove();
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  confirm.addEventListener('click', () => { close(); onConfirm(); });
  actions.append(cancel, confirm);
  dialog.append(heading, summary, preview, actions);
  overlay.append(dialog);
  document.body.append(overlay);
  confirm.focus();
}
