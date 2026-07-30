/**
 * Required-update check for the generated userscript.
 * The version and install URL are injected by the bundler from package.json.
 */

import { state } from './state.js';

const VERSION_CHECK_TIMEOUT_MS = 8000;
let updateCheckPromise = null;

function parseVersion(version) {
  const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;

    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return Number(left[index]) > Number(right[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

/** Compare two semantic versions. Returns 1 when left is newer, -1 when older. */
export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) return null;

  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] === right.numbers[index]) continue;
    return left.numbers[index] > right.numbers[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Read the userscript version from its metadata header. */
export function extractUserscriptVersion(source) {
  return String(source || '').match(/^\s*\/\/\s*@version\s+([^\s]+)\s*$/m)?.[1] || null;
}

function requestRemoteUserscript(request) {
  return new Promise((resolve, reject) => {
    request({
      method: 'GET',
      url: `${SEGMENTSCRAPER_UPDATE_URL}?update-check=${Date.now()}`,
      timeout: VERSION_CHECK_TIMEOUT_MS,
      headers: { 'Cache-Control': 'no-cache' },
      onload: response => {
        if (response.status < 200 || response.status >= 300) {
          reject(new Error(`GitHub returned HTTP ${response.status}`));
          return;
        }
        resolve(response.responseText);
      },
      onerror: () => reject(new Error('GitHub request failed')),
      ontimeout: () => reject(new Error('GitHub request timed out')),
    });
  });
}

/**
 * Check GitHub once per page load. A failed check is fail-open; a confirmed newer
 * version is fail-closed and must be installed before normal use continues.
 */
export function checkForRequiredUpdate(request = _GM_xmlhttpRequest) {
  if (updateCheckPromise) return updateCheckPromise;

  state.updateStatus = 'checking';
  state.currentVersion = SEGMENTSCRAPER_VERSION;
  state.updateUrl = SEGMENTSCRAPER_UPDATE_URL;

  updateCheckPromise = (async () => {
    if (typeof request !== 'function') {
      state.updateStatus = 'unavailable';
      return { required: false, status: state.updateStatus };
    }

    try {
      const source = await requestRemoteUserscript(request);
      const latestVersion = extractUserscriptVersion(source);
      const comparison = compareVersions(latestVersion, SEGMENTSCRAPER_VERSION);
      if (!latestVersion || comparison === null) throw new Error('GitHub version is invalid');

      state.latestVersion = latestVersion;
      state.updateRequired = comparison > 0;
      state.updateStatus = state.updateRequired ? 'required' : 'current';
      return { required: state.updateRequired, status: state.updateStatus, latestVersion };
    } catch (error) {
      state.updateStatus = 'unavailable';
      console.warn('[NFE] Update check unavailable; continuing with the installed version.', error);
      return { required: false, status: state.updateStatus, error };
    }
  })();

  return updateCheckPromise;
}
