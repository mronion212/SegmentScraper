const $ = id => document.getElementById(id);
let session, jobs = [], selectedTorrent, libraryProvider, polling = false, lastJobs = '', libraryItems = [], savedProviders = [], detailSequence = 0;
const selectedFiles = new Set();
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function api(route, body) {
  const res = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-App-Token': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || 'Aanvraag mislukt.'); return result;
}
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const b = el('button', text, 'secondary'); b.onclick = () => run(b, action); return b; }
async function run(b, action) { b.disabled = true; try { await action(); } catch (e) { notice(e.message, true); } finally { b.disabled = false; } }
function bind(id, action) { $(id).onclick = () => run($(id), action); }
const bytes = n => n == null ? 'onbekend' : `${(n / 1024 ** 3).toFixed(2)} GB`;
const time = n => n == null ? '—' : `${Math.floor(n / 3600).toString().padStart(2, '0')}:${Math.floor(n / 60 % 60).toString().padStart(2, '0')}:${(n % 60).toFixed(3).padStart(6, '0')}`;
function resetLibrary() { detailSequence++; libraryItems = []; libraryProvider = undefined; selectedTorrent = undefined; selectedFiles.clear(); $('library-warning').textContent = ''; $('library-summary').textContent = ''; $('torrents').replaceChildren(el('p', 'Verbind of ververs deze provider.', 'empty')); $('files').replaceChildren(el('p', 'Selecteer een film of seizoenspakket.', 'empty')); }
$('provider').onchange = () => { resetLibrary(); $('source').disabled = $('provider').value !== 'torbox'; $('restore').hidden = !savedProviders.includes($('provider').value); $('connection').textContent = 'Ververs om verbinding te controleren'; };
function renderTorrents(torrents, provider, warnings = []) {
  if ($('provider').value !== provider) return;
  resetLibrary(); libraryProvider = provider; libraryItems = torrents;
  $('connection').textContent = '● Verbonden';
  $('library-warning').textContent = warnings.join(' ');
  filterLibrary();
}
const sourceNames = { torrents: 'Torrent', usenet: 'Usenet', webdl: 'Webdownload' };
function filterLibrary() {
  const provider = libraryProvider;
  const search = $('search').value.trim().toLowerCase();
  const torrents = libraryItems.filter(t => (!$('ready-only').checked || t.ready) && (provider !== 'torbox' || $('source').value === 'all' || t.source === $('source').value) && String(t.name).toLowerCase().includes(search));
  $('library-summary').textContent = `${torrents.length} getoond · ${libraryItems.filter(t => t.ready).length} direct beschikbaar · ${libraryItems.length} in je bibliotheek`;
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
    b.className = `torrent${torrent.ready ? ' ready' : ''}`; b.append(el('small', `${sourceNames[torrent.source] || 'Torrent'} · ${torrent.ready ? 'Direct beschikbaar' : `${torrent.status} · ${torrent.progress ?? 0}%`} · ${bytes(torrent.size)}${torrent.videoCount == null ? '' : ` · ${torrent.videoCount} video's`}`)); $('torrents').append(b);
  }
  if (!torrents.length) $('torrents').append(el('p', libraryItems.length ? 'Geen resultaten met deze filters. Zet “Alleen direct beschikbaar” uit om andere items te bekijken.' : 'Geen items gevonden. Controleer of dit hetzelfde TorBox-account is als in Nuvio en ververs de bibliotheek.', 'empty'));
}
$('search').oninput = filterLibrary; $('source').onchange = filterLibrary; $('ready-only').onchange = filterLibrary;
function renderFiles(provider) {
  const t = selectedTorrent; const host = $('files'); host.replaceChildren(el('h2', t.name), el('small', `Providerstatus: ${t.status} · ${t.files.length} videobestanden`));
  const row = el('div', undefined, 'row');
  row.append(button('Alles selecteren', () => { t.files.filter(f => f.downloadable).forEach(f => selectedFiles.add(f.id)); renderFiles(provider); }), button('Niets selecteren', () => { selectedFiles.clear(); renderFiles(provider); }));
  if (provider === 'real-debrid' && t.status === 'waiting_files_selection') row.append(button('Hele pakket ophalen bij provider', async () => { await api('select-all', { provider, id: t.id }); notice('Alle bestanden geselecteerd bij Real-Debrid. Ververs wanneer het pakket klaar is.'); }));
  host.append(row);
  for (const f of t.files) {
    const label = el('label', undefined, 'file'), check = el('input'); check.type = 'checkbox'; check.checked = selectedFiles.has(f.id); check.disabled = !f.downloadable;
    check.onchange = () => check.checked ? selectedFiles.add(f.id) : selectedFiles.delete(f.id);
    label.append(check, el('span', `${f.name} · ${bytes(f.size)}${f.downloadable ? '' : ' · niet beschikbaar'}`)); host.append(label);
  }
  const download = button('Selectie downloaden & controleren', async () => { const result = await api('download', { provider, id: t.id, files: [...selectedFiles], mode: $('mode').value }); notice(`${result.count} bestanden toegevoegd aan de wachtrij.`); await poll(); });
  const inspect = button('Chapters lezen via provider', async () => { const result = await api('inspect-provider', { provider, id: t.id, files: [...selectedFiles], mode: $('mode').value }); notice(`${result.count} bestanden worden rechtstreeks bij de provider gecontroleerd.`); await poll(); });
  const actions = el('div', undefined, 'row file-actions'); download.disabled = inspect.disabled = !t.ready; actions.append(inspect, download); host.append(actions);
  host.append(el('small', 'Chapters lezen bewaart geen video op je computer. De benodigde gegevens worden wel via je provider gelezen; dit kan bandbreedte gebruiken.'));
  if (!t.ready) host.append(el('p', 'Dit pakket is nog niet klaar bij je provider. Ververs later.'));
}
const statuses = { queued: 'In wachtrij', downloading: 'Downloaden', checking: 'Chapters controleren', done: 'Afgerond', error: 'Mislukt', cancelled: 'Geannuleerd' };
function renderJobs() {
  const opened = new Set([...document.querySelectorAll('details[open]')].map(n => n.dataset.id));
  $('jobs').replaceChildren(); $('count').textContent = jobs.length;
  for (const job of jobs) {
    const node = el('article', undefined, 'job'), head = el('div', undefined, 'job-head');
    head.append(el('strong', job.name, 'job-title'), el('span', statuses[job.status], 'badge'));
    node.append(head);
    if (job.remote) node.append(el('small', 'Chaptercontrole rechtstreeks via provider'));
    if (!['done', 'error', 'cancelled'].includes(job.status)) node.append(button('Annuleren', async () => { await api('cancel', { id: job.id }); await poll(); }));
    if (job.status === 'downloading') { node.append(el('small', `${bytes(job.bytes)} / ${bytes(job.total)}`)); const p = el('progress'); if (job.total) { p.max = job.total; p.value = job.bytes; } node.append(p); }
    if (job.error) node.append(el('p', job.error));
    if (job.savedPath) node.append(el('small', `Opgeslagen: ${job.savedPath}`));
    if (job.report) {
      const r = job.report;
      node.append(el('small', `${r.media_type === 'movie' ? 'Film' : r.media_type === 'tv' ? `Serie · S${r.season ?? '?'}E${r.episode ?? '?'}` : 'Mediatype nog te beoordelen'} · ${time(r.duration)} · ${r.chapters.length} chapters`));
      if (!r.chapters.length) node.append(el('p', 'Geen chapters aanwezig. Er zijn geen segmenten afgeleid.'));
      else {
        const detail = el('details'); detail.dataset.id = job.id; detail.open = opened.has(job.id); detail.append(el('summary', r.status === 'review' ? 'Chapters bekijken · tijdgrenzen controleren' : 'Chapters & suggesties bekijken'));
        const table = el('table', undefined, 'chapter-table'), tr = el('tr'); ['Chapter', 'Start', 'Einde', 'Suggestie / beoordeling'].forEach(v => tr.append(el('th', v))); const thead = el('thead'); thead.append(tr); table.append(thead);
        const tbody = el('tbody');
        for (const c of r.chapters) { const row = el('tr'); [c.title, time(c.start_sec), time(c.end_sec), [c.suggestion ? `${c.suggestion} (controleren)` : 'Geen segmentlabel', ...c.issues].join(' · ')].forEach(v => row.append(el('td', v))); tbody.append(row); }
        table.append(tbody); detail.append(table); node.append(detail);
      }
    }
    $('jobs').append(node);
  }
  if (!jobs.length) $('jobs').append(el('p', 'Nog geen bestanden. Voeg hierboven je eerste film of serie toe.', 'empty'));
}
async function poll() {
  if (polling) return; polling = true;
  try { const state = await api('status'); jobs = state.jobs; $('destination').textContent = `Downloadmap: ${state.downloadDir}`; const snapshot = JSON.stringify(jobs); if (snapshot !== lastJobs) { lastJobs = snapshot; renderJobs(); } } finally { polling = false; }
}
bind('scan', async () => { const r = await api('local', { paths: $('paths').value.split(/\r?\n/).map(v => v.trim().replace(/^"|"$/g, '')).filter(Boolean), mode: $('mode').value }); notice(`${r.count} lokale bestanden toegevoegd.`); await poll(); });
bind('connect', async () => { const provider = $('provider').value; const token = $('token').value; $('token').value = ''; const remember = Boolean(window.desktop && $('remember').checked); const r = await api('connect', { provider, token, remember }); savedProviders = savedProviders.filter(p => p !== provider); if (remember) savedProviders.push(provider); $('restore').hidden = !remember; renderTorrents(r.torrents, provider, r.warnings); notice('Je bestaande bibliotheek is geladen. Kies een film of seizoen.'); });
bind('disconnect', async () => { const provider = $('provider').value; await api('disconnect', { provider }); savedProviders = savedProviders.filter(p => p !== provider); $('restore').hidden = true; $('connection').textContent = 'Niet verbonden'; resetLibrary(); notice('Provider losgekoppeld en onthouden sleutel verwijderd.'); });
bind('refresh', async () => { const provider = $('provider').value; const r = await api('torrents', { provider }); renderTorrents(r.torrents, provider, r.warnings); });
async function restore() { const provider = $('provider').value; const r = await api('restore', { provider }); renderTorrents(r.torrents, provider, r.warnings); }
bind('restore', restore);
bind('clear', async () => { await api('clear', {}); await poll(); });
bind('export', async () => {
  const reports = jobs.filter(j => j.report).map(j => j.report); if (!reports.length) throw new Error('Er zijn nog geen rapporten.');
  const report = JSON.stringify({ schema: 'segmentscraper-chapter-report/v1', created_at: new Date().toISOString(), reports }, null, 2);
  if (window.desktop) { if (await window.desktop.saveReport(report)) notice('Rapport opgeslagen.'); return; }
  const blob = new Blob([report], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = 'chapter-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
if (window.desktop) {
  document.querySelectorAll('.desktop-only').forEach(node => { node.hidden = false; });
  const appendPaths = paths => { $('paths').value = [...new Set([...$('paths').value.split(/\r?\n/).filter(Boolean), ...paths])].join('\n'); };
  bind('pick-files', async () => appendPaths(await window.desktop.pickFiles()));
  bind('pick-folder', async () => appendPaths(await window.desktop.pickFolder()));
  bind('choose-destination', async () => { if (await window.desktop.pickDestination()) { notice('Downloadmap aangepast voor nieuwe taken.'); await poll(); } });
}
(async () => { session = (await (await fetch('/api/session')).json()).token; const health = await api('health'); savedProviders = health.savedProviders || []; $('restore').hidden = !savedProviders.includes($('provider').value); $('health').textContent = health.ffprobe ? '● Chaptercontrole gereed' : '○ ffprobe ontbreekt'; if (!health.ffprobe) notice('ffprobe is niet gevonden. Gebruik de volledige desktopbuild of stel FFPROBE_PATH in.'); await poll(); setInterval(() => poll().catch(e => notice(e.message, true)), 1800); if (savedProviders.includes($('provider').value)) await restore(); })().catch(e => notice(e.message, true));
