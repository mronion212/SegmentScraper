/** Videoland programme layouts group episode cards into season blocks. */
function videolandSeasonNumber(block) {
  const label = block?.analytics?.tealium?.block_title || block?.title || '';
  const match = String(label).match(/\b(?:seizoen|season)\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function videolandEpisodeBlock(block) {
  const feature = String(block?.analytics?.tealium?.from || '');
  const label = String(block?.analytics?.tealium?.block_title || block?.title || '');
  return videolandSeasonNumber(block) != null && !/recommend|related|trailer|advertis/i.test(`${feature} ${label}`);
}

export function extractVideolandEpisodeCatalog(layout, programId) {
  const episodes = new Map();
  for (const block of layout?.blocks || []) {
    if (!videolandEpisodeBlock(block)) continue;
    const season = videolandSeasonNumber(block);
    for (const row of block.content?.items || []) {
      const item = row?.itemContent;
      const target = item?.action?.target;
      const video = target?.type === 'layout' ? target.value_layout : null;
      if (!video || video.type !== 'video' || video.id == null) continue;
      if (video.parent?.id != null && String(video.parent.id) !== String(programId)) continue;
      if (item.isAvailable === false || item.isPlayable === false || item.isComingSoon === true) continue;
      const label = String(item.extraTitle || item.title || '');
      const episode = Number(item.episode ?? item.metadata?.episode ?? item.video?.episode ?? label.match(/^\s*#?(\d+)\s*[.):\-]/)?.[1]);
      if (!Number.isInteger(episode) || episode < 1) continue;
      const title = String(item.episodeTitle || item.image?.caption || item.extraTitle || item.title || '')
        .replace(/^\s*#?\d+\s*[.):\-]\s*/, '').trim();
      const entry = { providerId: String(video.id), season, episode, title };
      const previous = episodes.get(entry.providerId);
      if (previous && (previous.season !== season || previous.episode !== episode)) throw new Error('Videoland returned conflicting episode numbering.');
      episodes.set(entry.providerId, entry);
    }
  }
  return [...episodes.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function videolandItemIds(items) {
  return (items || []).map(row => row?.itemContent?.action?.target?.value_layout?.id ?? row?.itemContent?.video?.id ?? row?.id ?? null);
}

function videolandPaginationInfo(pagination) {
  return ['currentPage', 'nextPage', 'totalPages', 'totalItems', 'itemsPerPage'].filter(key =>
    pagination?.[key] != null && /^\d+$/.test(String(pagination[key])))
    .map(key => `${key}=${pagination[key]}`).join(', ');
}

/** Follow both section and episode cursors, using the observed layout route. */
export async function loadVideolandEpisodeCatalog({ layout, url, programId, request }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.hostname !== 'layout.videoland.bedrock.tech' || !/\/(?:program|video)\/[^/]+\/layout$/.test(base.pathname)) {
    throw new Error('Unsupported Videoland catalogue endpoint.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(String(programId))) throw new Error('Invalid Videoland programme ID.');
  const originalPath = base.pathname;
  base.pathname = base.pathname.replace(/\/(?:program|video)\/[^/]+\/layout$/, `/program/${encodeURIComponent(programId)}/layout`);
  base.searchParams.delete('page');
  base.searchParams.set('blockPage', '1');
  base.searchParams.set('nbPages', '2');
  let requests = 0;
  const get = async (url, stage) => {
    if (++requests > 200) throw new Error(`Videoland catalogue pagination limit reached while loading ${stage} (200 requests).`);
    const result = await request(url.href);
    if (!result || typeof result !== 'object') throw new Error('Videoland returned an invalid catalogue page.');
    if (result.entity?.id != null && String(result.entity.id) !== String(programId)) throw new Error('Videoland returned another programme catalogue.');
    return result;
  };
  const initialCursor = new URL(url).searchParams.get('blockPage') || '1';
  // A video layout contains recommendations and a partial episode window. Load
  // the programme itself, including its first page, before trusting its count.
  const first = originalPath === base.pathname && initialCursor === '1' ? layout : await get(base, 'season sections');
  if (first?.entity?.id != null && String(first.entity.id) !== String(programId)) throw new Error('Videoland returned another programme catalogue.');
  const blocks = [...(first?.blocks || [])];
  const seenBlocks = new Set(['1']);
  const sectionSignature = blocks => JSON.stringify(blocks.map(block => [block.blockId, videolandItemIds(block.content?.items)]));
  const seenSectionContents = new Set([sectionSignature(blocks)]);
  let next = first?.pagination?.nextPage;
  while (next != null) {
    if (!/^[1-9]\d*$/.test(String(next)) || seenBlocks.has(String(next))) throw new Error('Videoland section pagination did not advance.');
    seenBlocks.add(String(next));
    const pageUrl = new URL(base);
    pageUrl.searchParams.set('blockPage', String(next));
    const page = await get(pageUrl, `season sections, page ${next}`);
    if (!Array.isArray(page.blocks) || !page.blocks.length) throw new Error('Videoland returned an incomplete section page.');
    const signature = sectionSignature(page.blocks);
    if (seenSectionContents.has(signature) && page.pagination?.nextPage != null) {
      throw new Error(`Videoland repeated the same season sections at page ${next}; ${videolandPaginationInfo(page.pagination)}. Open the series page and retry.`);
    }
    seenSectionContents.add(signature);
    blocks.push(...page.blocks);
    next = page.pagination?.nextPage;
  }
  const complete = [];
  for (const block of blocks) {
    if (!videolandEpisodeBlock(block)) continue;
    const items = [...(block.content?.items || [])];
    let cursor = block.content?.pagination?.nextPage;
    const seen = new Set();
    const seenItemContents = new Set([JSON.stringify(videolandItemIds(items))]);
    let pagesPerRequest = 8;
    while (cursor != null) {
      if (!/^[1-9]\d*$/.test(String(cursor)) || seen.has(String(cursor)) || !/^[A-Za-z0-9_-]+$/.test(String(block.blockId || ''))) {
        throw new Error('Videoland episode pagination did not advance.');
      }
      seen.add(String(cursor));
      const pageUrl = new URL(base);
      pageUrl.pathname = pageUrl.pathname.replace(/\/layout$/, `/block/${encodeURIComponent(block.blockId)}`);
      pageUrl.searchParams.delete('blockPage');
      pageUrl.searchParams.set('page', String(cursor));
      pageUrl.searchParams.set('nbPages', String(pagesPerRequest));
      let page;
      const stage = `season ${videolandSeasonNumber(block)}, episode page ${cursor}`;
      try { page = await get(pageUrl, stage); }
      catch (error) {
        // Some catalogue blocks support only one page per request. Never retry
        // authentication, rate-limit, or malformed-data failures as a batch.
        if (pagesPerRequest === 1 || ![500, 502, 503, 504].includes(error.status)) throw error;
        pagesPerRequest = 1;
        pageUrl.searchParams.set('nbPages', '1');
        page = await get(pageUrl, stage);
      }
      if (!Array.isArray(page.content?.items)) throw new Error('Videoland returned an incomplete episode page.');
      const signature = JSON.stringify(videolandItemIds(page.content.items));
      if (page.content.items.length && seenItemContents.has(signature) && page.content.pagination?.nextPage != null) {
        throw new Error(`Videoland repeated episode contents for ${stage}; ${videolandPaginationInfo(page.content.pagination)}. Open the series page and retry.`);
      }
      seenItemContents.add(signature);
      items.push(...page.content.items);
      cursor = page.content.pagination?.nextPage;
    }
    complete.push({ ...block, content: { ...block.content, items } });
  }
  const episodes = extractVideolandEpisodeCatalog({ blocks: complete }, programId);
  if (!episodes.length) throw new Error('Videoland did not provide a usable season episode catalogue. Open the series page and retry.');
  return episodes;
}
