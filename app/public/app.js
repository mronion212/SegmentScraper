const $ = id => document.getElementById(id);
let session, jobs = [], selectedTorrent, libraryProvider, polling = false, lastJobs = '', libraryItems = [], savedProviders = [], detailSequence = 0;
const selectedFiles = new Set();
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function api(route, body) {
  const res = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-App-Token': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const b = el('button', text, 'secondary'); b.onclick = () => run(b, action); return b; }
async function run(b, action) { b.disabled = true; try { await action(); } catch (e) { notice(e.message, true); } finally { b.disabled = false; } }
function bind(id, action) { $(id).onclick = () => run($(id), action); }
const bytes = n => n == null ? 'unknown' : `${(n / 1024 ** 3).toFixed(2)} GB`;
const time = n => n == null ? '—' : `${Math.floor(n / 3600).toString().padStart(2, '0')}:${Math.floor(n / 60 % 60).toString().padStart(2, '0')}:${(n % 60).toFixed(3).padStart(6, '0')}`;
function resetLibrary() { detailSequence++; libraryItems = []; libraryProvider = undefined; selectedTorrent = undefined; selectedFiles.clear(); $('library-warning').textContent = ''; $('library-summary').textContent = ''; $('torrents').replaceChildren(el('p', 'Connect or refresh this provider.', 'empty')); $('files').replaceChildren(el('p', 'Select a movie or season pack.', 'empty')); }
$('provider').onchange = () => { resetLibrary(); $('source').disabled = $('provider').value !== 'torbox'; $('restore').hidden = !savedProviders.includes($('provider').value); $('connection').textContent = 'Refresh to check connection'; };
function renderTorrents(torrents, provider, warnings = []) {
  if ($('provider').value !== provider) return;
  resetLibrary(); libraryProvider = provider; libraryItems = torrents;
  $('connection').textContent = '● Connected';
  $('library-warning').textContent = warnings.join(' ');
  filterLibrary();
}
const sourceNames = { torrents: 'Torrent', usenet: 'Usenet', webdl: 'Webdownload' };
function filterLibrary() {
  const provider = libraryProvider;
  const search = $('search').value.trim().toLowerCase();
  const torrents = libraryItems.filter(t => (!$('ready-only').checked || t.ready) && (provider !== 'torbox' || $('source').value === 'all' || t.source === $('source').value) && String(t.name).toLowerCase().includes(search));
  $('library-summary').textContent = `${torrents.length} shown · ${libraryItems.filter(t => t.ready).length} ready · ${libraryItems.length} in your library`;
  $('torrents').replaceChildren();
  for (const torrent of torrents) {
    const b = button(torrent.name, async () => {
      const sequence = ++detailSequence;
      const detail = await api('files', { provider, id: torrent.id });
      if (libraryProvider !== provider || sequence !== detailSequence) return;
      selectedTorrent = detail; selectedFiles.clear();
      for (const f of detail.files) if (f.downloadable) selectedFiles.add(f.id);
      document.querySelectorAll('.torrent').forEach(n => n.classList.remove('selected')); b.classList.add('selected'); renderFiles(provider);
    });
    b.className = `torrent${torrent.ready ? ' ready' : ''}`; b.append(el('small', `${sourceNames[torrent.source] || 'Torrent'} · ${torrent.ready ? 'Ready to inspect' : `${torrent.status} · ${torrent.progress ?? 0}%`} · ${bytes(torrent.size)}${torrent.videoCount == null ? '' : ` · ${torrent.videoCount} videos`}`)); $('torrents').append(b);
  }
  if (!torrents.length) $('torrents').append(el('p', libraryItems.length ? 'No matches. Turn off “Ready to inspect only” to see other items.' : 'No items found. Check that this is the same account used in Nuvio, then refresh.', 'empty'));
}
$('search').oninput = filterLibrary; $('source').onchange = filterLibrary; $('ready-only').onchange = filterLibrary;
function renderFiles(provider) {
  const t = selectedTorrent; const host = $('files'); host.replaceChildren(el('h2', t.name), el('small', `Provider status: ${t.status} · ${t.files.length} video files`));
  const row = el('div', undefined, 'row');
  row.append(button('Select all', () => { t.files.filter(f => f.downloadable).forEach(f => selectedFiles.add(f.id)); renderFiles(provider); }), button('Deselect all', () => { selectedFiles.clear(); renderFiles(provider); }));
  if (provider === 'real-debrid' && t.status === 'waiting_files_selection') row.append(button('Request entire pack from provider', async () => { await api('select-all', { provider, id: t.id }); notice('All files selected at Real-Debrid. Refresh when the pack is ready.'); }));
  host.append(row);
  for (const f of t.files) {
    const label = el('label', undefined, 'file'), check = el('input'); check.type = 'checkbox'; check.checked = selectedFiles.has(f.id); check.disabled = !f.downloadable;
    check.onchange = () => check.checked ? selectedFiles.add(f.id) : selectedFiles.delete(f.id);
    label.append(check, el('span', `${f.name} · ${bytes(f.size)}${f.downloadable ? '' : ' · unavailable'}`)); host.append(label);
  }
  const download = button('Download & inspect selection', async () => { const result = await api('download', { provider, id: t.id, files: [...selectedFiles], mode: $('mode').value }); notice(`${result.count} files added to the queue.`); await poll(); });
  const inspect = button('Inspect directly from provider', async () => { const result = await api('inspect-provider', { provider, id: t.id, files: [...selectedFiles], mode: $('mode').value }); notice(`${result.count} files queued for direct provider inspection.`); await poll(); });
  const actions = el('div', undefined, 'row file-actions'); download.disabled = inspect.disabled = !t.ready; actions.append(inspect, download); host.append(actions);
  host.append(el('small', 'Direct inspection does not save the video locally. It reads data through your provider and uses bandwidth.'));
  if (!t.ready) host.append(el('p', 'This pack is not ready at your provider. Refresh later.'));
}
const statuses = { queued: 'Queued', downloading: 'Downloading', checking: 'Inspect chapters', analyzing: 'Analyzing ending', done: 'Inspection finished', error: 'Failed', cancelled: 'Cancelled' };
function renderJobs() {
  const opened = new Set([...document.querySelectorAll('details[open]')].map(n => n.dataset.id));
  $('jobs').replaceChildren(); $('count').textContent = jobs.length;
  for (const job of jobs) {
    const node = el('article', undefined, 'job'), head = el('div', undefined, 'job-head');
    head.append(el('strong', job.name, 'job-title'), el('span', statuses[job.status], 'badge'));
    node.append(head);
    if (job.remote) node.append(el('small', 'Inspected directly from provider'));
    if (!['done', 'error', 'cancelled'].includes(job.status)) node.append(button('Cancel', async () => { await api('cancel', { id: job.id }); await poll(); }));
    if (job.status === 'downloading') { node.append(el('small', `${bytes(job.bytes)} / ${bytes(job.total)}`)); const p = el('progress'); if (job.total) { p.max = job.total; p.value = job.bytes; } node.append(p); }
    if (job.error) node.append(el('p', job.error));
    if (job.savedPath) node.append(el('small', `Saved: ${job.savedPath}`));
    if (job.report) {
      const r = job.report;
      node.append(button('Review for IntroDB', () => { $('upload-job').value=job.id; loadUploadJob(); $('upload-panel').scrollIntoView({behavior:'smooth'}); }));
      if(r.duration && r.duration<600) node.append(el('p','Short video: verify that this is not a trailer or sample.','review-warning'));
      node.append(el('small', `${r.media_type === 'movie' ? 'Movie' : r.media_type === 'tv' ? `TV · S${r.season ?? '?'}E${r.episode ?? '?'}` : 'Media type needs review'} · ${time(r.duration)} · ${r.chapters.length} chapters`));
      if (!r.chapters.length) node.append(el('p', 'No embedded chapters were reported by ffprobe. Provider skip markers are separate metadata. Try downloading and inspecting locally to verify; otherwise enter manually verified timestamps below.'));
      else {
        const detail = el('details'); detail.dataset.id = job.id; detail.open = opened.has(job.id); detail.append(el('summary', r.status === 'review' ? 'Review chapters · timing issues found' : 'Review chapters & suggestions'));
        const table = el('table', undefined, 'chapter-table'), tr = el('tr'); ['Chapter', 'Start', 'End', 'Suggestion / review'].forEach(v => tr.append(el('th', v))); const thead = el('thead'); thead.append(tr); table.append(thead);
        const tbody = el('tbody');
        for (const c of r.chapters) { const row = el('tr'); [c.title, time(c.start_sec), time(c.end_sec), [c.suggestion ? `${c.suggestion} (review required)` : 'No segment label', ...c.issues].join(' · ')].forEach(v => row.append(el('td', v))); tbody.append(row); }
        table.append(tbody); detail.append(table); node.append(detail);
      }
    }
    $('jobs').append(node);
  }
  if (!jobs.length) $('jobs').append(el('p', 'No files yet. Add local media or select files from your provider above.', 'empty'));
}
async function poll() {
  if (polling) return; polling = true;
  try { const state = await api('status'); jobs = state.jobs; if (typeof renderUploadState === "function") renderUploadState(state); $('destination').textContent = `Download folder: ${state.downloadDir}`; const snapshot = JSON.stringify(jobs); if (snapshot !== lastJobs) { lastJobs = snapshot; renderJobs(); } } finally { polling = false; }
}
bind('scan', async () => { const r = await api('local', { paths: $('paths').value.split(/\r?\n/).map(v => v.trim().replace(/^"|"$/g, '')).filter(Boolean), mode: $('mode').value }); notice(`${r.count} local files added.`); await poll(); });
bind('connect', async () => { const provider = $('provider').value; const token = $('token').value; $('token').value = ''; const remember = Boolean(window.desktop && $('remember').checked); const r = await api('connect', { provider, token, remember }); savedProviders = savedProviders.filter(p => p !== provider); if (remember) savedProviders.push(provider); $('restore').hidden = !remember; renderTorrents(r.torrents, provider, r.warnings); notice('Library loaded. Choose a movie or season.'); });
bind('disconnect', async () => { const provider = $('provider').value; await api('disconnect', { provider }); savedProviders = savedProviders.filter(p => p !== provider); $('restore').hidden = true; $('connection').textContent = 'Not connected'; resetLibrary(); notice('Provider disconnected and saved key removed.'); });
bind('refresh', async () => { const provider = $('provider').value; const r = await api('torrents', { provider }); renderTorrents(r.torrents, provider, r.warnings); });
async function restore() { const provider = $('provider').value; const r = await api('restore', { provider }); renderTorrents(r.torrents, provider, r.warnings); }
bind('restore', restore);
bind('clear', async () => { await api('clear', {}); await poll(); });
bind('export', async () => {
  const reports = jobs.filter(j => j.report).map(j => j.report); if (!reports.length) throw new Error('There are no reports yet.');
  const status = await api('status');
  const report = JSON.stringify({ schema: 'segmentscraper-chapter-report/v1', created_at: new Date().toISOString(), reports, uploads:status.uploads || [] }, null, 2);
  if (window.desktop) { if (await window.desktop.saveReport(report)) notice('Report saved.'); return; }
  const blob = new Blob([report], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = 'chapter-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
if (window.desktop) {
  document.querySelectorAll('.desktop-only').forEach(node => { node.hidden = false; });
  const appendPaths = paths => { $('paths').value = [...new Set([...$('paths').value.split(/\r?\n/).filter(Boolean), ...paths])].join('\n'); };
  bind('pick-files', async () => appendPaths(await window.desktop.pickFiles()));
  bind('pick-folder', async () => appendPaths(await window.desktop.pickFolder()));
  bind('choose-destination', async () => { if (await window.desktop.pickDestination()) { notice('Download folder updated for new tasks.'); await poll(); } });
}
(async () => { session = (await (await fetch('/api/session')).json()).token; const health = await api('health'); savedProviders = health.savedProviders || []; $('restore').hidden = !savedProviders.includes($('provider').value); $('health').textContent = health.ffprobe ? '● Inspection ready' : '○ ffprobe missing'; if (!health.ffprobe) notice('ffprobe was not found. Use the full desktop build or configure FFPROBE_PATH.'); await poll(); setInterval(() => poll().catch(e => notice(e.message, true)), 1800); if (savedProviders.includes($('provider').value)) await restore(); })().catch(e => notice(e.message, true));
