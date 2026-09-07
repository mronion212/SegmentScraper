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
  const videos = [...root.querySelectorAll('video')].map(video => video.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
  const isPlaybackControl = anchor => {
    if (!anchor || !anchor.matches('button, [role="button"]') || anchor.closest('[role="slider"], .vjs-progress-control, [data-uia="timeline"]')) return false;
    const rect = anchor.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    // Reject top toolbars and controls belonging to another part of the page.
    return videos.some(video => rect.top >= video.top + video.height / 2 && rect.top <= video.bottom + 60 && rect.left >= video.left && rect.right <= video.right + 1);
  };
  for (const selector of PLAYER_CONTROL_ANCHORS[providerName] || []) {
    for (const candidate of root.querySelectorAll(selector)) {
      const anchor = candidate.matches('button, [role="button"]') ? candidate : candidate.querySelector('button, [role="button"]');
      if (isPlaybackControl(anchor)) return anchor;
    }
  }
  // Semantic play/pause controls cover alternate player builds without relying on
  // a next-episode button (which is absent for movies and season finales).
  for (const anchor of root.querySelectorAll('button[aria-label], button[title]')) {
    const label = anchor.getAttribute('aria-label') || anchor.title || '';
    if (/^(play|pause|afspelen|pauzeren)( video| playback)?$/i.test(label.trim()) && isPlaybackControl(anchor)) return anchor;
  }
  return null;
}

export function injectBtn(providerName, getAnchor = getNextEpBtn) {
  if (!document.body) return;
  let button = document.getElementById('nfe-btn');
  const anchor = getAnchor(providerName);
  if (!anchor) {
    button?.remove();
    return;
  }
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
  const mode = 'controls';
  if (button.dataset.placement !== mode) {
    button.dataset.placement = mode;
    button.style.cssText = 'all:initial;box-sizing:border-box;color:white;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle;';
    button.style.cssText += 'width:40px;height:40px;margin:0 4px;border-radius:4px;';
  }
  if (anchor) {
    if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) {
      anchor.insertAdjacentElement('beforebegin', button);
    }
  }
  if (!document.getElementById('nfe-button-style')) {
    const style = document.createElement('style');
    style.id = 'nfe-button-style';
    style.textContent = '#nfe-btn:hover{background:rgba(255,255,255,.16)!important}#nfe-btn:focus-visible{outline:2px solid white!important;outline-offset:2px}';
    (document.head || document.body).appendChild(style);
  }
}
