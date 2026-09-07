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
    if (verified && providerName === 'videoland') {
      // The volume wrapper and fullscreen wrapper share the bottom utility row.
      return verified.parentElement?.parentElement?.querySelector('button[aria-label="Volledig scherm"], button[aria-label="Fullscreen"], button[aria-label="Exit fullscreen"], button[aria-label="Verlaat volledig scherm"]') || verified;
    }
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
  const wrapped = providerName === 'prime-video' && anchor.id === 'atvwebplayersdk-skip-backward-button'
    || providerName === 'videoland' && (anchor.id === 'volume-bar-control' || parent?.children.length === 1) && parent.parentElement;
  return { reference: wrapped ? parent : anchor, wrapped: Boolean(wrapped) };
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
    button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 5v14M16 5v14M3 10h5m8 0h5M3 14h5m8 0h5" stroke="currentColor" stroke-width="1.5"/></svg>';
    button.addEventListener('click', event => {
      event.stopPropagation();
      event.preventDefault();
      togglePanel();
    });
    button.addEventListener('keydown', event => event.stopPropagation());
  }
  const { reference, wrapped } = getControlMount(providerName, anchor);
  const native = providerName === 'prime-video' || providerName === 'skyshowtime' || providerName === 'videoland';
  const appearance = providerName + ':' + (native ? anchor.className : '');
  if (button.dataset.appearance !== appearance) {
    button.dataset.appearance = appearance;
    button.dataset.placement = 'controls';
    // Preserve the provider's box size, padding and vertical alignment.
    button.className = native ? anchor.className : '';
    button.style.cssText = native
      ? 'cursor:pointer;flex-shrink:0;align-self:center;'
      : 'box-sizing:border-box;color:white;background:transparent;border:0;padding:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle;width:40px;height:40px;margin:0 4px;border-radius:4px;';
    const icon = button.querySelector('svg');
    icon.style.cssText = 'display:block;margin:auto;pointer-events:none;';
    if (native) icon.setAttribute('class', anchor.querySelector('svg')?.getAttribute('class') || '');
  }
  let slot = document.getElementById('nfe-button-slot');
  if (wrapped) {
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'nfe-button-slot';
    }
    if (slot.className !== reference.className) slot.className = reference.className;
    // No provider-owned node is moved or restyled.
    slot.style.cssText = 'display:flex;align-items:center;justify-content:center;align-self:center;flex-shrink:0;';
    if (button.parentElement !== slot) slot.appendChild(button);
    if (slot.parentElement !== reference.parentElement || slot.nextElementSibling !== reference) reference.insertAdjacentElement('beforebegin', slot);
  } else {
    if (button.parentElement !== reference.parentElement || button.nextElementSibling !== reference) reference.insertAdjacentElement('beforebegin', button);
    slot?.remove();
  }
  mountedPlayerControl = { providerName, anchor };
  if (!document.getElementById('nfe-button-style')) {
    const style = document.createElement('style');
    style.id = 'nfe-button-style';
    style.textContent = '#nfe-btn:focus-visible{outline:2px solid white!important;outline-offset:2px}';
    (document.head || document.body).appendChild(style);
  }
}
