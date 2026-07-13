/**
 * Netflix-specific segment extraction module
 * Handles detection, fetching, parsing, and normalization of Netflix segment data
 */

import { state } from '../../core/state.js';
import { createNormalizedSegment } from '../../normalization/segment-mapper.js';
import { searchImdbByTitle, loadExistingSegments, loadExistingSegmentsForEpisode, submitSegment } from '../../core/network.js';
import { toast, updateCounters, updatePanelTitle, openPanel, closePanel, updateImdbInput } from '../../ui/panel.js';

// Manual overrides for shows where IMDb's title-suggestion search returns
// the wrong entry. Keyed by Netflix's stable series-level video.id.
export const NETFLIX_TITLE_OVERRIDES = {
  '81748089': 'tt2431250', // Het kleine huis op de prairie -> correct IMDb entry
};

/**
 * Process Netflix metadata and extract segments
 * @param {Object} data - The metadata response from Netflix API
 * @param {string} providerName - The provider name
 */
export function processMetadata(data, providerName) {
  const video = data.video;
  if (!video) return;

  if (video.title && state.showTitle !== video.title) {
    state.showTitle = video.title;
    state.showId = video.id != null ? String(video.id) : null;
    state.showYear = '';
    if (video.seasons && video.seasons[0]) {
      state.showYear = String(video.seasons[0].year || '');
    }
    state.dbSearchDone = false;
    state.imdbId = '';
    state.existingSegments = new Set();
    state.existingSegmentsLoaded = false;
    updatePanelTitle();
    console.log(`[NFE] Show ID (stable, series-level): ${state.showId}`);
  }

  if (!state.dbSearchDone && state.showTitle) {
    state.dbSearchDone = true;
    const override = state.showId && NETFLIX_TITLE_OVERRIDES[state.showId];
    console.log('[NFE] IMDb lookup triggered for showTitle:', state.showTitle, 'showYear:', state.showYear, 'override:', override);
    if (override) {
      state.imdbId = override;
      state.allItems.forEach(i => { 
        if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = override; 
      });
      updateImdbInput();
      setDbStatus(`Manual override applied · ID: ${override}`);
      updateCounters();
      loadExistingSegments(override);
     } else {
       searchImdbByTitle(state.showTitle, state.showYear).then(result => {
         console.log('[NFE] IMDb search result:', result);
         if (result.success) {
           state.imdbId = result.imdbId;
           state.allItems.forEach(i => { 
             if (i.imdb_id === 'IMDB_PENDING') i.imdb_id = result.imdbId; 
           });
           updateImdbInput();
           setDbStatus(`Found: ${result.imdbId}`);
           updateCounters();
           loadExistingSegments(result.imdbId);
         } else {
           setDbStatus(`IMDb lookup failed: ${result.error}`);
         }
       }).catch(err => {
         console.error('[NFE] IMDb search error:', err);
         setDbStatus('IMDb lookup error');
       });
     }
   }

  let newItems = 0;
  for (const season of (video.seasons || [])) {
    const sNum = season.seq;
    for (const ep of (season.episodes || [])) {
      const eid = ep.episodeId || ep.id;
      if (state.allItems.some(i => i._eid === eid)) continue;

      const eNum = ep.seq;
      const tid = state.imdbId || 'IMDB_PENDING';
      const mk = ep.skipMarkers || {};

      // Extract segments using normalization layer
      const recap = mk.recap;
      if (recap && recap.end > 0) {
        const item = createNormalizedSegment({
          providerSegmentType: 'recap',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: recap.start / 1000,
          endSec: recap.end / 1000,
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }

      const credit = mk.credit;
      if (credit && credit.end > 0) {
        const item = createNormalizedSegment({
          providerSegmentType: 'credit',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: credit.start / 1000,
          endSec: credit.end / 1000,
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }

      const intro = mk.intro;
      if (intro && intro.end > 0) {
        const item = createNormalizedSegment({
          providerSegmentType: 'intro',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: intro.start / 1000,
          endSec: intro.end / 1000,
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }

      // Outro from creditsOffset and runtime
      if (ep.creditsOffset && ep.runtime) {
        const item = createNormalizedSegment({
          providerSegmentType: 'creditsOffset',
          providerName,
          episodeId: eid,
          season: sNum,
          episode: eNum,
          startSec: parseFloat(ep.creditsOffset),
          endSec: parseFloat(ep.runtime),
          imdbId: tid
        });
        if (item) {
          state.allItems.push(item);
          newItems++;
        }
      }
    }
  }

  if (newItems > 0) {
    state.interceptedCount++;
    updateCounters();
    toast(`+${newItems} timestamps captured · total: ${state.allItems.length}`);
  }
}

/**
 * Set the IMDb status message
 */
export function setDbStatus(msg) {
  state.dbStatusMsg = msg;
  const el = document.getElementById('nfe-imdb-status');
  if (el) el.textContent = msg;
}

/**
 * Set the IntroDB status message
 */
export function setIntrodbStatus(msg) {
  const el = document.getElementById('nfe-introdb-status');
  if (el) el.textContent = msg;
}

/**
 * Export captured timestamps to JSON files
 */
export async function exportJSON() {
  if (!state.allItems.length) { 
    toast('No timestamps yet.'); 
    return; 
  }

  // Group by each item's OWN imdb_id
  let items = state.allItems.map(({ _eid, ...rest }) => rest);
  const pendingCount = items.filter(i => i.imdb_id === 'IMDB_PENDING').length;
  if (pendingCount > 0) {
    const proceed = confirm(`${pendingCount} timestamp(s) still have no IMDb ID assigned (IMDB_PENDING).\nThese will be exported as-is. Continue?`);
    if (!proceed) return;
  }

  // Local dedup against IntroDB
  const episodeKeys = [...new Set(
    items
      .filter(i => i.imdb_id && i.imdb_id !== 'IMDB_PENDING')
      .map(i => `${i.imdb_id}|${i.season}|${i.episode}`)
  )];
  
  const notLoaded = episodeKeys.filter(k => !(state.dedupCacheV2 && state.dedupCacheV2[k]));
  if (notLoaded.length > 0) {
    toast(`Checking IntroDB for existing segments (${notLoaded.length} episode(s))...`);
    await Promise.all(notLoaded.map(k => loadExistingSegmentsForEpisode(k)));
  }

  const beforeCount = items.length;
  items = items.filter(item => {
    const key = `${item.imdb_id}|${item.season}|${item.episode}`;
    const cache = state.dedupCacheV2 && state.dedupCacheV2[key];
    if (!cache) return true;
    return !cache.has(item.segment_type);
  });
  
  const dupCount = beforeCount - items.length;
  if (dupCount > 0) toast(`${dupCount} duplicate(s) already in IntroDB removed from export.`);

  if (!items.length) { 
    toast('Nothing left to export after removing duplicates.'); 
    return; 
  }

  // Group by IMDb ID for file output
  const groups = new Map();
  for (const item of items) {
    const key = item.imdb_id || 'no_id';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  // Build files and download with delay
  const files = [];
  const N = 100;
  for (const [tid, groupItems] of groups) {
    const total = Math.ceil(groupItems.length / N);
    for (let i = 0; i < total; i++) {
      files.push({
        tid,
        part: total > 1 ? `_part${i + 1}of${total}` : '',
        data: groupItems.slice(i * N, (i + 1) * N),
      });
    }
  }

  let downloaded = 0;
  function downloadNext(idx) {
    if (idx >= files.length) {
      toast(`${downloaded} file(s) downloaded across ${groups.size} series · ${items.length} entries`);
      return;
    }
    const f = files[idx];
    const blob = new Blob([JSON.stringify({ items: f.data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `timestamps_${f.tid}${f.part}.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    downloaded++;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTimeout(() => downloadNext(idx + 1), 400);
  }
  downloadNext(0);
}

/**
 * Submit all timestamps to IntroDB
 */
export function submitToIntroDB() {
  if (!state.allItems.length) { 
    toast('No timestamps to submit.'); 
    return; 
  }

  const apiKey = state.introdbApiKey;
  if (!apiKey) {
    toast('Please enter your IntroDB API key in the panel above.');
    setIntrodbStatus('No API key configured');
    return;
  }

  if (state.submitInProgress) { 
    toast('Submission in progress, please wait...'); 
    return; 
  }

  // Each item keeps its OWN imdb_id
  const allMapped = state.allItems.map(({ _eid, ...rest }) => rest);
  const pendingItems = allMapped.filter(i => i.imdb_id === 'IMDB_PENDING');
  if (pendingItems.length > 0) {
    toast(`${pendingItems.length} timestamp(s) have no IMDb ID yet (IMDB_PENDING) and will be skipped.`);
  }

  const items = allMapped.filter(item => item.imdb_id !== 'IMDB_PENDING' && !isAlreadyInIntroDB(item));
  const skipped = allMapped.length - items.length;

  if (!items.length) {
    toast('All timestamps already exist in IntroDB.');
    setIntrodbStatus('Nothing new to submit (all duplicates)');
    return;
  }

  const skipMsg = skipped > 0 ? ` (${skipped} already existed, skipped)` : '';
  const idList = [...new Set(items.map(i => i.imdb_id))].join(', ');
  if (!confirm(`Submit ${items.length} timestamp${items.length !== 1 ? 's' : ''} to IntroDB?${skipMsg}\nID(s): ${idList}`)) return;

  state.submitInProgress = true;
  state.submitResults = { ok: 0, fail: 0 };
  updateSubmitBtn('Submitting 0/' + items.length + '...');

  let sent = 0;

  function sendNext(idx) {
    if (idx >= items.length) {
      state.submitInProgress = false;
      const { ok, fail } = state.submitResults;
      updateSubmitBtn('📡 Submit to IntroDB');
      toast(`IntroDB: ${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      setIntrodbStatus(`${ok} submitted · ${fail} failed${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
      return;
    }

    const item = items[idx];
    submitSegment(item, apiKey).then(result => {
      sent++;
      if (result.success) {
        state.submitResults.ok++;
        state.existingSegments.add(`${item.season}_${item.episode}_${item.segment_type}`);
      } else {
        state.submitResults.fail++;
        console.warn('[NFE] IntroDB rejected:', result.status, item);
      }
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(idx + 1), 150);
    }).catch(() => {
      sent++;
      state.submitResults.fail++;
      updateSubmitBtn(`Submitting ${sent}/${items.length}...`);
      setTimeout(() => sendNext(idx + 1), 150);
    });
  }

  sendNext(0);
}

/**
 * Check if a segment already exists in IntroDB
 */
export function isAlreadyInIntroDB(item) {
  return state.existingSegments.has(`${item.season}_${item.episode}_${item.segment_type}`);
}

/**
 * Update the submit button label
 */
export function updateSubmitBtn(label) {
  const btn = document.getElementById('nfe-submit');
  if (btn) btn.textContent = label;
}

/**
 * Clear all captured data
 */
export function clearData() {
  if (!confirm('Delete all captured timestamps?')) return;
  Object.assign(state, {
    allItems: [],
    imdbId: '',
    interceptedCount: 0,
    dbSearchDone: false,
    dbStatusMsg: 'Waiting for Netflix metadata...',
    showTitle: '',
    showYear: '',
    submitResults: { ok: 0, fail: 0 },
    existingSegments: new Set(),
    existingSegmentsLoaded: false,
  });
  updateCounters();
  updatePanelTitle();
  setDbStatus('Waiting for Netflix metadata...');
  setIntrodbStatus('');
  updateImdbInput();
  toast('Data cleared');
}
