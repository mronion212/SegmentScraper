/**
 * Shared button component
 * Injects a trigger button into the player UI
 */

import { getProviderConfig } from '../config/provider-config.js';
import { togglePanel } from './panel.js';

/**
 * Get the "next episode" button element (provider-specific)
 * @param {string} providerName - The provider name
 * @returns {HTMLElement|null} - The next episode button element
 */
export function getNextEpBtn(providerName) {
  // Default implementation - can be overridden by provider
  return (
    document.querySelector('[data-uia="control-next-episode"]') ||
    document.querySelector('button[aria-label*="iguiente" i]') ||
    document.querySelector('button[aria-label*="Next Episode" i]') ||
    document.querySelector('button[aria-label*="next-episode" i]')
  );
}

/**
 * Inject the trigger button into the page
 * @param {string} providerName - The provider name for theming
 * @param {Function} [getNextBtn] - Optional custom function to get next button
 */
export function injectBtn(providerName, getNextBtn) {
  if (document.getElementById('nfe-btn')) {
    return;
  }
  
  const config = getProviderConfig(providerName);
  if (!config) {
    console.error('[NFE] No config found for provider:', providerName);
    return;
  }
  const { colors } = config;
  
  const nextBtn = getNextBtn ? getNextBtn() : getNextEpBtn(providerName);
  console.log('[NFE] nextBtn found:', !!nextBtn);

  const btn = document.createElement('button');
  btn.id = 'nfe-btn';
  btn.title = 'Timestamps Extractor';
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      xmlns="http://www.w3.org/2000/svg" style="display:block">
    <rect x="2" y="5" width="20" height="14" rx="1.5" stroke="white" stroke-width="1.6" fill="none"/>
    <line x1="6"  y1="5"  x2="6"  y2="19" stroke="white" stroke-width="1.6"/>
    <line x1="18" y1="5"  x2="18" y2="19" stroke="white" stroke-width="1.6"/>
    <line x1="2"  y1="9"  x2="6"  y2="9"  stroke="white" stroke-width="1.4"/>
    <line x1="18" y1="9"  x2="22" y2="9"  stroke="white" stroke-width="1.4"/>
    <line x1="2"  y1="15" x2="6"  y2="15" stroke="white" stroke-width="1.4"/>
    <line x1="18" y1="15" x2="22" y2="15" stroke="white" stroke-width="1.4"/>
    <polyline points="9,10 12,13.5 15,10" stroke="white" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <line x1="12" y1="8" x2="12" y2="13.5" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

  if (nextBtn) {
    btn.style.cssText = `
      background:none; border:none; cursor:pointer; padding:0; margin:0;
      width:40px; height:40px; display:inline-flex; align-items:center; justify-content:center;
      opacity:0.85; transition:opacity 0.15s, transform 0.15s; flex-shrink:0; vertical-align:middle;
      z-index:2147483000;
    `;
    btn.addEventListener('mouseenter', () => { 
      btn.style.opacity = '1';    
      btn.style.transform = 'scale(1.15)'; 
    });
    btn.addEventListener('mouseleave', () => { 
      btn.style.opacity = '0.85'; 
      btn.style.transform = 'scale(1)';    
    });
    nextBtn.insertAdjacentElement('beforebegin', btn);
    console.log('[NFE] Button inserted before nextBtn');
  } else {
    // Fallback: fixed floating button
    btn.style.cssText = `
      background:rgba(0,0,0,0.6); border:none; cursor:pointer; padding:6px; margin:0;
      width:36px; height:36px; display:inline-flex; align-items:center; justify-content:center;
      border-radius:6px; opacity:0.85; transition:opacity 0.15s; flex-shrink:0;
      position:fixed; bottom:90px; right:20px; z-index:2147483000;
    `;
    btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
    btn.addEventListener('mouseleave', () => (btn.style.opacity = '0.85'));
    document.body.appendChild(btn);
    console.log('[NFE] Button appended to body as fallback');
  }

  btn.addEventListener('click', e => { 
    console.log('[NFE] Button clicked, calling togglePanel');
    try {
      e.stopPropagation(); 
      e.preventDefault(); 
      if (typeof togglePanel === 'function') {
        togglePanel();
      } else {
        console.error('[NFE] togglePanel is not a function:', typeof togglePanel);
      }
    } catch (err) {
      console.error('[NFE] Error in button click handler:', err);
    }
  });
  console.log('[NFE] Button click handler attached');
}