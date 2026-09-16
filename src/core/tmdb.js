/** TMDB presence checks. Credentials stay in userscript storage, outside public state. */
const TMDB_TOKEN_STORAGE = 'segmentScraper.tmdb.token';
const tmdbSceneCache = new Map();

export function saveTmdbToken(value) {
  if (typeof GM_setValue !== 'function') return false;
  try {
    GM_setValue(TMDB_TOKEN_STORAGE, String(value || '').trim().replace(/^Bearer\s+/i, ''));
    tmdbSceneCache.clear();
    return true;
  } catch (_) { return false; }
}

function tmdbRequest(path, token) {
  return new Promise(resolve => {
    const xhr = (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest)
      || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
    if (!xhr) { resolve(null); return; }
    try {
      xhr({ method: 'GET', url: `https://api.themoviedb.org/3${path}`,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 10000,
        onload: response => {
          try { resolve(response.status === 200 ? JSON.parse(response.responseText) : null); }
          catch (_) { resolve(null); }
        }, onerror: () => resolve(null), ontimeout: () => resolve(null), onabort: () => resolve(null),
      });
    } catch (_) { resolve(null); }
  });
}

export async function checkTmdbExtraScenes(imdbId) {
  if (!/^tt\d+$/.test(String(imdbId))) return { status: 'unavailable', reason: 'Invalid IMDb ID' };
  let token = '';
  try { token = typeof GM_getValue === 'function' ? String(GM_getValue(TMDB_TOKEN_STORAGE, '') || '').trim() : ''; }
  catch (_) {}
  if (!token) return { status: 'unavailable', reason: 'Save your TMDB API Read Access Token first' };
  const cached = tmdbSceneCache.get(imdbId);
  if (cached && cached.expires > Date.now()) return cached.result;
  const found = await tmdbRequest(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`, token);
  if (!Array.isArray(found?.movie_results) || found.movie_results.length !== 1
    || !Number.isInteger(found.movie_results[0]?.id) || found.movie_results[0].id <= 0) {
    return { status: 'unavailable', reason: 'TMDB movie lookup failed or was ambiguous' };
  }
  const tmdbId = found.movie_results[0].id;
  const data = await tmdbRequest(`/movie/${tmdbId}/keywords`, token);
  if (!Array.isArray(data?.keywords) || data.keywords.some(keyword => typeof keyword?.name !== 'string')) {
    return { status: 'unavailable', reason: 'TMDB keyword check failed; verify token or retry' };
  }
  const keywords = data.keywords.map(keyword => String(keyword?.name || '').trim().toLowerCase())
    .filter(name => ['aftercreditsstinger', 'duringcreditsstinger'].includes(name));
  const result = { status: keywords.length ? 'present' : 'unknown', tmdbId, keywords };
  if (tmdbSceneCache.size >= 200) tmdbSceneCache.delete(tmdbSceneCache.keys().next().value);
  tmdbSceneCache.set(imdbId, { result, expires: Date.now() + 15 * 60 * 1000 });
  return result;
}
