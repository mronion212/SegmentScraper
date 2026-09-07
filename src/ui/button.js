/** Mount the extractor as a native control-row item, never inside a play-button wrapper. */
import { togglePanel } from './panel.js';

const PLAYER_CONTROL_ANCHORS = {
  netflix: ['[data-uia="control-fullscreen-enter"]', '[data-uia="control-fullscreen-exit"]', '[data-uia="control-audio-subtitle"]', '[data-uia="control-play-pause-play"]', '[data-uia="control-play-pause-pause"]'],
  'prime-video': ['.atvwebplayersdk-fullscreen-button', '.atvwebplayersdk-subtitles-button', '.atvwebplayersdk-playpause-button'],
  videoland: ['.vjs-fullscreen-control', '.vjs-play-control', '[data-testid="fullscreen-button"]', '[data-testid="play-pause-button"]'],
  skyshowtime: ['[data-testid="fullscreen-button"]', '[data-testid="player-fullscreen-button"]', '.vjs-fullscreen-control', '[data-testid="play-pause-button"]'],
  crunchyroll: ['[data-testid="fullscreen-button"]', '[data-testid="vilos-fullscreen-button"]', '[data-testid="play-pause-button"]', '.vjs-fullscreen-control'],
};

// These anchors were verified against supplied player markup. Their structural
// identity remains valid while the provider hides its controls.
const VERIFIED_CONTROL_ANCHORS = {
  'prime-video': '#atvwebplayersdk-skip-backward-button',
  videoland: '#volume-bar-control',
  skyshowtime: '[data-testid="playback-lower-controls"] [data-testid="language-settings-button"]',
};
let mountedPlayerControl = null;

export function getNextEpBtn(providerName) {
  const root = document.fullscreenElement || document;
  const verifiedSelector = VERIFIED_CONTROL_ANCHORS[providerName];
  if (verifiedSelector) {
    const verified = root.querySelector(verifiedSelector);

    if (verified) return verified;
  }
  const videos = [...root.querySelectorAll('video')].map(video => video.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
  const isPlaybackControl = anchor => {
    if (!anchor || !anchor.matches('button, [role="button"]') || anchor.closest('[role="slider"], .vjs-progress-control, [data-uia="timeline"]')) return false;
    const rect = anchor.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return videos.some(video => rect.top >= video.top + video.height / 2 && rect.top <= video.bottom + 60 && rect.left >= video.left && rect.right <= video.right + 1);
  };
  for (const selector of PLAYER_CONTROL_ANCHORS[providerName] || []) {
    for (const candidate of root.querySelectorAll(selector)) {
      const anchor = candidate.matches('button, [role="button"]') ? candidate : candidate.querySelector('button, [role="button"]');
      if (isPlaybackControl(anchor)) return anchor;
    }
  }
  for (const anchor of root.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label]')) {
    const label = anchor.getAttribute('aria-label') || anchor.title || '';
    if (/^(play|pause|afspelen|pauzeren)(?:$|\s|\()/i.test(label.trim()) && isPlaybackControl(anchor)) return anchor;
  }
  return null;
}

/** Pure structural decision; wrapped native controls receive a sibling slot. */
export function getControlMount(providerName, anchor) {
  const parent = anchor.parentElement;
  if (providerName === 'videoland' && anchor.id === 'volume-bar-control') {
    // Reserve space beside the entire volume/fullscreen group. Do not enlarge a
    // fixed-size fullscreen wrapper or depend on its changing translated label.
    return { reference: parent.parentElement, wrapped: true, after: false };
  }
  if (providerName === 'skyshowtime' && anchor.getAttribute('data-testid') === 'language-settings-button') {
    return { reference: anchor, wrapped: false, after: true };
  }
  if (providerName === 'prime-video' && anchor.id === 'atvwebplayersdk-skip-backward-button') {
    return { reference: parent, wrapped: true, after: false };
  }
  // Lift past single-control wrappers until reaching a row containing other
  // native controls. Inserting inside a fixed fullscreen wrapper stacks buttons.
  let reference = anchor;
  for (let container = parent; container && !container.matches?.('body, html'); container = container.parentElement) {
    const count = container.querySelectorAll?.('button:not(#nfe-btn), [role="button"]:not(#nfe-btn)').length;
    if (count > 1) return { reference, wrapped: reference !== anchor, after: false };
    if (count == null) break;
    reference = container;
  }
  return { reference: anchor, wrapped: false, after: false };
}

export function removePlayerButton() {
  document.getElementById('nfe-button-slot')?.remove();
  document.getElementById('nfe-btn')?.remove();
  mountedPlayerControl = null;
}

export function injectBtn(providerName, getAnchor = getNextEpBtn) {
  if (!document.body) return;
  let button = document.getElementById('nfe-btn');
  let anchor = getAnchor(providerName);
  const root = document.fullscreenElement || document;
  if (!anchor && mountedPlayerControl?.providerName === providerName &&
      mountedPlayerControl.anchor.isConnected && root.contains(mountedPlayerControl.anchor)) {
    // Zero-sized/hidden controls are not evidence that the player was removed.
    anchor = mountedPlayerControl.anchor;
  }
  if (!anchor) { removePlayerButton(); return; }
  if (!button) {
    button = document.createElement('button');
    button.id = 'nfe-btn';
    button.type = 'button';
    button.title = 'Open SegmentScraper';
    button.setAttribute('aria-label', 'Open SegmentScraper');
    button.setAttribute('aria-controls', 'nfe-panel');
    button.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'display:block!important;width:28px!important;height:28px!important;pointer-events:none!important;';
    // Provider SVG rules must not turn the filmstrip into a filled square.
    const shadow = icon.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host{color:white}svg{display:block;width:28px;height:28px;fill:none}</style><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="20" height="14" rx="1.5" stroke="white" stroke-width="1.6" fill="none"/><path d="M6 5v14M18 5v14M2 9h4m12 0h4M2 15h4m12 0h4" stroke="white" stroke-width="1.4" fill="none"/><polyline points="9,10 12,13.5 15,10" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M12 8v5.5" stroke="white" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
    button.appendChild(icon);
    button.addEventListener('click', event => {
      event.stopPropagation();
      event.preventDefault();
      togglePanel();
    });
    button.addEventListener('keydown', event => event.stopPropagation());
  }
  const { reference, after } = getControlMount(providerName, anchor);
  button.dataset.placement = 'controls';
  button.className = '';
  const rect = anchor.getBoundingClientRect();
  const height = rect.height > 0 ? Math.max(40, Math.min(64, rect.height)) : 40;
  const buttonStyle = 'all:initial;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;width:40px!important;min-width:40px!important;height:' + height + 'px!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important;color:white!important;cursor:pointer!important;flex:0 0 40px!important;position:static!important;transform:none!important;';
  if (button.dataset.controlHeight !== String(height)) {
    button.dataset.controlHeight = String(height);
    button.style.cssText = buttonStyle;
  }
  let slot = document.getElementById('nfe-button-slot');
  if (!slot) {
    slot = document.createElement('span');
    slot.id = 'nfe-button-slot';
    slot.style.cssText = 'all:initial;box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;align-self:center!important;vertical-align:middle!important;flex:0 0 48px!important;width:48px!important;min-width:48px!important;margin:0 4px!important;padding:0!important;position:static!important;';
  }
  if (button.parentElement !== slot) slot.appendChild(button);
  const correctlyPlaced = after ? reference.nextElementSibling === slot : slot.nextElementSibling === reference;
  if (slot.parentElement !== reference.parentElement || !correctlyPlaced) reference.insertAdjacentElement(after ? 'afterend' : 'beforebegin', slot);
  mountedPlayerControl = { providerName, anchor };
  if (!document.getElementById('nfe-button-style')) {
    const style = document.createElement('style');
    style.id = 'nfe-button-style';
    style.textContent = '#nfe-btn:focus-visible{outline:2px solid white!important;outline-offset:2px}';
    (document.head || document.body).appendChild(style);
  }
}
