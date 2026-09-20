/** Tab-scoped recovery across reloads. Credentials and network caches are excluded. */
import { state } from './state.js';

let captureSessionKey = '';
let captureSaveTimer = null;
const CAPTURE_FIELDS = ['allItems', 'showTitle', 'mediaType', 'showId', 'showYear', 'imdbId', 'imdbIdsByShowId', 'providerEpisodes', 'providerEpisodesByShowId', 'interceptedCount'];

export function saveCaptureSession() {
  if (!captureSessionKey) return;
  clearTimeout(captureSaveTimer);
  captureSaveTimer = null;
  try {
    const data = Object.fromEntries(CAPTURE_FIELDS.map(key => [key, state[key]]));
    const savedAt = new Date().toISOString();
    sessionStorage.setItem(captureSessionKey, JSON.stringify({ version: 1, savedAt, data, showIds: [...state.showIds] }));
    state.sessionSavedAt = savedAt;
    state.sessionStorageError = false;
  } catch (_) {
    state.sessionStorageError = true;
  }
}

export function scheduleCaptureSave() {
  if (!captureSessionKey || captureSaveTimer !== null) return;
  captureSaveTimer = setTimeout(saveCaptureSession, 500);
}

export function restoreCaptureSession(providerName) {
  captureSessionKey = `segmentScraper.capture.v1.${providerName}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(captureSessionKey) || 'null');
    if (saved?.version !== 1 || !Array.isArray(saved.data?.allItems) || !Array.isArray(saved.showIds)) return false;
    if (!saved.data.allItems.every(item => item && typeof item === 'object' && Number.isFinite(Number(item.start_sec)) && Number.isFinite(Number(item.end_sec)))) return false;
    for (const key of CAPTURE_FIELDS) {
      if (Object.hasOwn(saved.data, key)) state[key] = saved.data[key];
    }
    state.showIds = new Set(saved.showIds);
    state.sessionSavedAt = saved.savedAt;
    state.dbSearchDone = false;
    return state.allItems.length > 0;
  } catch (_) {
    state.sessionStorageError = true;
    return false;
  }
}

export function clearCaptureSession() {
  clearTimeout(captureSaveTimer);
  captureSaveTimer = null;
  try { sessionStorage.removeItem(captureSessionKey); } catch (_) { state.sessionStorageError = true; }
  state.sessionSavedAt = '';
}
