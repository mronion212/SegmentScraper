import { isVideo } from './media.mjs';

export const torboxReady = t => t.download_present === true && t.download_finished === true;
const sources = { torrents: 'torrent_id', usenet: 'usenet_id', webdl: 'web_id' };
function resource(key) {
  const [source, id] = String(key).includes(':') ? String(key).split(':') : ['torrents', String(key)];
  if (!Object.hasOwn(sources, source) || !/^\d+$/.test(id)) throw new Error('Ongeldig bibliotheekitem.');
  return { source, id };
}

export class Debrid {
  constructor(provider, token, fetcher = fetch) {
    if (!['torbox', 'real-debrid'].includes(provider)) throw new Error('Onbekende provider.');
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Vul een geldige API-sleutel in.');
    this.provider = provider; this.token = token.trim(); this.fetch = fetcher;
    this.base = provider === 'torbox' ? 'https://api.torbox.app/v1/api' : 'https://api.real-debrid.com/rest/1.0';
  }
  async request(endpoint, body, signal) {
    let response;
    try {
      response = await this.fetch(this.base + endpoint, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}` }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
    } catch { throw new Error('Provider niet bereikbaar of aanvraag geannuleerd.'); }
    if (!response.ok) throw new Error(`Providerfout (${response.status}). Controleer je sleutel, account en limieten.`);
    if (response.status === 204) return null;
    const json = await response.json();
    if (this.provider === 'torbox') {
      if (json.success !== true) throw new Error('TorBox kon de aanvraag niet uitvoeren. Controleer de status in je account.');
      return json.data;
    }
    return json;
  }
  async library({ source = 'all', fresh = true } = {}) {
    if (this.provider !== 'torbox') return { torrents: await this.list({ fresh }), warnings: [] };
    if (source !== 'all' && !Object.hasOwn(sources, source)) throw new Error('Onbekend bibliotheekonderdeel.');
    const requested = source === 'all' ? Object.keys(sources) : [source];
    const results = await Promise.allSettled(requested.map(source => this.list({ source, fresh })));
    if (results.every(r => r.status === 'rejected')) throw results[0].reason;
    return { torrents: results.flatMap(r => r.status === 'fulfilled' ? r.value : []), warnings: results.flatMap((r, i) => r.status === 'rejected' ? [`${requested[i]} kon niet worden geladen. Controleer je accountrechten of probeer opnieuw.`] : []) };
  }
  async list({ fresh = false, source = 'torrents' } = {}) {
    if (!Object.hasOwn(sources, source)) throw new Error('Onbekend bibliotheekonderdeel.');
    const torrents = [];
    for (let page = 0; page < 100; page++) {
      const rows = await this.request(this.provider === 'torbox' ? `/${source}/mylist?offset=${page * 100}&limit=100${fresh ? '&bypass_cache=true' : ''}` : `/torrents?offset=${page * 100}&limit=100`);
      if (!Array.isArray(rows)) throw new Error('Onverwacht antwoord van provider.');
      torrents.push(...rows.map(t => ({ id: this.provider === 'torbox' ? `${source}:${t.id}` : String(t.id), source, name: t.name || t.filename, status: t.download_state || t.status, progress: this.provider === 'torbox' ? Math.round((t.progress || 0) * 100) : t.progress,
        ready: this.provider === 'torbox' ? torboxReady(t) : t.status === 'downloaded', cached: t.cached === true, size: t.size ?? t.bytes, expiresAt: t.expires_at || null,
        videoCount: Array.isArray(t.files) ? t.files.filter(f => isVideo(f.name || f.path)).length : null })));
      if (rows.length < 100) return torrents;
    }
    throw new Error('Account bevat meer dan 10.000 torrents.');
  }
  async details(id, signal) {
    const target = this.provider === 'torbox' ? resource(id) : null;
    const t = await this.request(target ? `/${target.source}/mylist?id=${target.id}&bypass_cache=true` : `/torrents/info/${encodeURIComponent(id)}`, undefined, signal);
    if (!t || !Array.isArray(t.files)) throw new Error('Bestandslijst nog niet beschikbaar. Ververs zodra de metadata klaar is.');
    const selected = t.files.filter(f => f.selected === 1);
    return { id: target ? `${target.source}:${t.id}` : String(t.id), source: target?.source || 'torrents', name: t.name || t.filename, ready: this.provider === 'torbox' ? torboxReady(t) : t.status === 'downloaded', cached: t.cached === true, status: t.download_state || t.status,
      files: t.files.filter(f => isVideo(f.name || f.path)).map(f => ({ id: String(f.id), name: f.name || f.path, size: f.size ?? f.bytes, downloadable: !f.zipped && !f.infected, link: this.provider === 'real-debrid' && selected.length === t.links?.length ? t.links[selected.indexOf(f)] : undefined })) };
  }
  async selectAll(id) {
    if (this.provider === 'real-debrid') await this.request(`/torrents/selectFiles/${encodeURIComponent(id)}`, new URLSearchParams({ files: 'all' }));
  }
  async downloadLink(torrentId, fileId, signal) {
    const torrent = await this.details(torrentId, signal);
    const file = torrent.files.find(f => f.id === String(fileId));
    if (!torrent.ready || !file || !file.downloadable) throw new Error('Bestand is nog niet klaar of niet afzonderlijk beschikbaar.');
    if (this.provider === 'torbox') {
      const { source, id } = resource(torrentId);
      return this.request(`/${source}/requestdl?${new URLSearchParams({ token: this.token, [sources[source]]: id, file_id: fileId, redirect: 'false' })}`, undefined, signal);
    }
    if (!file.link) throw new Error('Geen eenduidige downloadlink. Selecteer de bestanden in je provider en ververs.');
    return (await this.request('/unrestrict/link', new URLSearchParams({ link: file.link }), signal)).download;
  }
}
