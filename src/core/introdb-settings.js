/** Local IntroDB credential storage. The key is never returned to UI code. */

import { state } from './state.js';

const INTRODB_API_KEY_STORAGE = 'segmentScraper.introdb.apikey';

function getStoredIntrodbValue(key, fallback = '') {
  try {
    return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setStoredIntrodbValue(key, value) {
  try {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  } catch (_) {}
}

export function loadIntrodbSettings() {
  state.introdbApiKey = String(getStoredIntrodbValue(INTRODB_API_KEY_STORAGE, '') || '');
  return { configured: Boolean(state.introdbApiKey) };
}

export function saveIntrodbSettings(apiKey) {
  const nextApiKey = String(apiKey || '').trim();
  state.introdbApiKey = nextApiKey;
  setStoredIntrodbValue(INTRODB_API_KEY_STORAGE, nextApiKey);
  return { configured: Boolean(nextApiKey) };
}
