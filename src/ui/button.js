/** Provider-specific playback controls; never attach to the seek bar. */
import { togglePanel } from './panel.js';

const PLAYER_CONTROL_ANCHORS = {
  netflix: ['[data-uia="control-fullscreen-enter"]', '[data-uia="control-fullscreen-exit"]', '[data-uia="control-audio-subtitle"]', '[data-uia="control-play-pause-play"]', '[data-uia="control-play-pause-pause"]'],
  'prime-video': ['.atvwebplayersdk-fullscreen-button', '.atvwebplayersdk-subtitles-button', '.atvwebplayersdk-playpause-button'],
  videoland: ['.vjs-fullscreen-control', '.vjs-play-control', '[data-testid="fullscreen-button"]', '[data-testid="play-pause-button"]'],
  skyshowtime: ['[data-testid="fullscreen-button"]', '[data-testid="player-fullscreen-button"]', '.vjs-fullscreen-control', '[data-testid="play-pause-button"]'],
  crunchyroll: ['[data-testid="fullscreen-button"]', '[data-testid="vilos-fullscreen-button"]', '[data-testid="play-pause-button"]', '.vjs-fullscreen-control'],
};

export function getNextEpBtn(providerName) {
  const root = document.fullscreenElement || document;
  for (const selector of PLAYER_CONTROL_ANCHORS[providerName] || []) {
    const anchor = root.querySelector(selector);
    if (anchor && !anchor.closest('[role="slider"], .vjs-progress-control, [data-uia="timeline"]')) return anchor;
  }
  return null;
}

export function injectBtn(providerName, getAnchor = getNextEpBtn) {
  if (!document.body) return;
  let button = document.getElementById('nfe-btn');
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
  const anchor = getAnchor(providerName);
  const mode = anchor ? 'controls' : 'floating';
  if (button.dataset.placement !== mode) {
    button.dataset.placement = mode;
    button.style.cssText = 'all:initial;box-sizing:border-box;color:white;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle;';
    button.style.cssText += anchor
      ? 'width:40px;height:40px;margin:0 4px;border-radius:4px;'
      : 'position:fixed;top:20px;right:20px;width:40px;height:40px;background:rgba(0,0,0,.7);border-radius:8px;z-index:2147483000;';
  }
  if (anchor) {
    if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) {
      anchor.insertAdjacentElement('beforebegin', button);
    }
  } else {
    const host = document.fullscreenElement || document.body;
    if (button.parentElement !== host) host.appendChild(button);
  }
  if (!document.getElementById('nfe-button-style')) {
    const style = document.createElement('style');
    style.id = 'nfe-button-style';
    style.textContent = '#nfe-btn:hover{background:rgba(255,255,255,.16)!important}#nfe-btn:focus-visible{outline:2px solid white!important;outline-offset:2px}';
    (document.head || document.body).appendChild(style);
  }
}
