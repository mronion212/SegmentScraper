const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));

function readSources(relativePaths) {
  return relativePaths
    .map(relativePath => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8'))
    .join('\n')
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, '');
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function benchmarkMousemoveBurst(moveCount = 500) {
  const counts = {
    getElementById: 0,
    querySelector: 0,
    computedStyle: 0,
    styleWrites: 0,
    timeoutCalls: 0,
    clearTimeoutCalls: 0,
    animationFrameCalls: 0,
    cancelAnimationFrameCalls: 0,
  };
  const listeners = new Map();
  const timers = new Map();
  const animationFrames = new Map();
  let nextAsyncId = 1;

  const countedStyle = () => new Proxy({}, {
    set(target, property, value) {
      counts.styleWrites++;
      target[property] = value;
      return true;
    },
  });
  const button = { style: countedStyle(), contains: () => false, remove() {} };
  const panel = { style: countedStyle(), contains: () => false, remove() {} };
  const controls = {};
  const document = {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    getElementById(id) {
      counts.getElementById++;
      if (id === 'nfe-btn') return button;
      if (id === 'nfe-panel') return panel;
      return null;
    },
    querySelector(selector) {
      counts.querySelector++;
      return selector === '[data-uia="controls-standard"]' ? controls : null;
    },
  };
  const state = {};
  const pageWindow = {};
  let intervalCallback = null;
  const context = vm.createContext({
    state,
    document,
    window: pageWindow,
    location: { pathname: '/browse' },
    console: { log() {}, info() {}, warn() {}, error() {} },
    createState: () => ({
      allItems: [],
      panelVisible: true,
      showIds: new Set(),
      providerEpisodes: [],
      imdbIdsByShowId: {},
    }),
    createEpisodeCacheKey: () => '',
    getProviderConfig: name => ({ name }),
    loadIntrodbSettings() {},
    loadTvdbSettings() {},
    saveIntrodbSettings() {},
    saveTvdbSettings() {},
    setProviderName() {},
    injectBtn() {},
    getNextEpBtn() { return null; },
    closePanel() {},
    updateCounters() {},
    updatePanelTitle() {},
    toast() {},
    updateImdbInput() {},
    showExportPreview() {},
    searchImdbByTitle: async () => ({ success: false }),
    lookupImdbTitle: async () => ({ success: false }),
    loadExistingSegments() {},
    loadExistingSegmentsForEpisode: async () => new Set(),
    submitSegment: async () => ({ success: true }),
    mapSeriesItemsToTvdb: async () => ({ success: false }),
    getComputedStyle() {
      counts.computedStyle++;
      return { opacity: '1' };
    },
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    setTimeout(callback) {
      counts.timeoutCalls++;
      const id = nextAsyncId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      counts.clearTimeoutCalls++;
      timers.delete(id);
    },
    requestAnimationFrame(callback) {
      counts.animationFrameCalls++;
      const id = nextAsyncId++;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      counts.cancelAnimationFrameCalls++;
      animationFrames.delete(id);
    },
    confirm: () => false,
    Blob: class {},
    URL,
  });
  let source = readSources(['src/providers/bootstrap.js']);
  source += '\nglobalThis.runtimeAuditExports = { bootstrapProvider };';
  vm.runInContext(source, context, { filename: 'bootstrap.js' });
  context.runtimeAuditExports.bootstrapProvider({
    providerName: 'netflix',
    setupInterception() {},
    isPlayerPage: () => false,
  });

  const mousemove = listeners.get('mousemove')?.[0];
  if (!mousemove) throw new Error('mousemove listener was not registered');
  const started = performance.now();
  for (let index = 0; index < moveCount; index++) mousemove({ type: 'mousemove' });
  const burstElapsedMs = performance.now() - started;
  const afterBurst = {
    ...snapshot(counts),
    pendingTimers: timers.size,
    pendingAnimationFrames: animationFrames.size,
  };

  const pendingFrames = [...animationFrames.values()];
  animationFrames.clear();
  pendingFrames.forEach(callback => callback(performance.now()));
  const pendingTimers = [...timers.values()];
  timers.clear();
  pendingTimers.forEach(callback => callback());

  return {
    moveCount,
    registeredListeners: Object.fromEntries(
      [...listeners].map(([type, callbacks]) => [type, callbacks.length])
    ),
    intervalRegistered: Boolean(intervalCallback),
    burstElapsedMs: Number(burstElapsedMs.toFixed(3)),
    afterBurst,
    afterFlushingPendingCallbacks: {
      ...snapshot(counts),
      pendingTimers: timers.size,
      pendingAnimationFrames: animationFrames.size,
    },
  };
}

function benchmarkCrunchyrollPolls(pollCount = 100) {
  const counts = {
    querySelectorAll: 0,
    structuredDataTextReads: 0,
    jsonParse: 0,
    handleDetectedShow: 0,
    recordProviderEpisode: 0,
    recordExtractedSegments: 0,
    gmRequests: 0,
  };
  const structuredData = [
    {
      '@id': 'https://www.crunchyroll.com/watch/G7PU403GE/nopperabo',
      '@type': 'TVEpisode',
      datePublished: '2018-04-16T14:00:00.000Z',
      episodeNumber: 2,
      name: 'Golden Kamuy | E2 - Nopperabo',
      partOfSeason: {
        '@id': 'https://www.crunchyroll.com/series/GY8DWQN5Y/golden-kamuy',
        '@type': 'TVSeason',
        name: 'Golden Kamuy',
        seasonNumber: 1,
      },
      partOfSeries: {
        '@id': 'https://www.crunchyroll.com/series/GY8DWQN5Y/golden-kamuy',
        '@type': 'TVSeries',
        name: 'Golden Kamuy',
      },
    },
    { '@type': 'VideoObject', name: 'Nopperabo' },
  ].map(JSON.stringify);
  const scriptNodes = structuredData.map(text => ({
    get textContent() {
      counts.structuredDataTextReads++;
      return text;
    },
  }));
  const document = {
    querySelectorAll() {
      counts.querySelectorAll++;
      return scriptNodes;
    },
    addEventListener() {},
  };
  const location = { pathname: '/watch/G7PU403GE/nopperabo' };
  const state = { allItems: [], imdbIdsByShowId: {}, providerEpisodes: [] };
  let intervalCallback = null;
  const pageWindow = { fetch: async () => ({ ok: false }) };
  const context = vm.createContext({
    state,
    document,
    location,
    window: pageWindow,
    JSON: {
      parse(value, reviver) {
        counts.jsonParse++;
        return JSON.parse(value, reviver);
      },
      stringify(value, replacer, space) {
        return JSON.stringify(value, replacer, space);
      },
    },
    console: { log() {}, info() {}, warn() {}, error() {} },
    handleDetectedShow() { counts.handleDetectedShow++; },
    recordProviderEpisode() { counts.recordProviderEpisode++; },
    recordExtractedSegments() { counts.recordExtractedSegments++; },
    createNormalizedSegment() { throw new Error('no segments expected in poll benchmark'); },
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    GM_xmlhttpRequest() { counts.gmRequests++; },
  });
  let source = readSources([
    'src/providers/timestamp-logger.js',
    'src/providers/crunchyroll/extractor.js',
  ]);
  source += '\nglobalThis.runtimeAuditExports = { setupCrunchyrollInterception };';
  vm.runInContext(source, context, { filename: 'crunchyroll-extractor.js' });
  context.runtimeAuditExports.setupCrunchyrollInterception();
  if (!intervalCallback) throw new Error('Crunchyroll polling interval was not registered');

  const started = performance.now();
  for (let index = 0; index < pollCount; index++) intervalCallback();
  const elapsedMs = performance.now() - started;
  return {
    initialScanPlusPolls: pollCount + 1,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    ...counts,
  };
}

function benchmarkPrimeCatalogScans(scanCount = 60, cardCount = 100) {
  const counts = {
    documentQuerySelector: 0,
    documentQuerySelectorAll: 0,
    cardQuerySelector: 0,
    handleDetectedShow: 0,
    recordProviderEpisode: 0,
  };
  const attributeElement = attributes => ({
    getAttribute(name) { return attributes[name] ?? null; },
  });
  const cards = Array.from({ length: cardCount }, (_, index) => {
    const episode = index + 1;
    const titleId = `B${String(episode).padStart(9, '0')}`;
    const heading = { textContent: `${episode}. Synthetic episode ${episode}` };
    const selector = attributeElement({ id: `selector-${titleId}` });
    selector.id = `selector-${titleId}`;
    return {
      querySelector(css) {
        counts.cardQuerySelector++;
        if (css === 'h3') return heading;
        if (css === 'input[id^="selector-"]') return selector;
        return null;
      },
    };
  });
  const seasonSelector = attributeElement({ 'aria-label': 'Season 1 is selected' });
  const document = {
    title: 'Prime Video: Synthetic Series - Season 1',
    querySelector(css) {
      counts.documentQuerySelector++;
      if (css === '#av-droplist-av-atf-season-selector') return seasonSelector;
      if (css === 'main h1') return { textContent: 'Synthetic Series' };
      return null;
    },
    querySelectorAll() {
      counts.documentQuerySelectorAll++;
      return cards;
    },
    getElementById() { return null; },
  };
  const state = {
    allItems: [],
    imdbId: '',
    imdbIdsByShowId: {},
    showTitle: '',
    showId: null,
    providerEpisodes: [],
  };
  const context = vm.createContext({
    state,
    document,
    location: { href: 'https://www.primevideo.com/detail/SYNTHETIC00' },
    console: { log() {}, info() {}, warn() {}, error() {} },
    handleDetectedShow() { counts.handleDetectedShow++; },
    recordProviderEpisode() { counts.recordProviderEpisode++; },
    recordExtractedSegments() {},
    setTimeout: () => 0,
    clearTimeout() {},
    atob: value => Buffer.from(value, 'base64').toString('utf8'),
    URL,
  });
  let source = readSources([
    'src/providers/timestamp-logger.js',
    'src/providers/prime-video/extractor.js',
  ]);
  source += '\nglobalThis.runtimeAuditExports = { scanPrimeVideoEpisodeCatalog };';
  vm.runInContext(source, context, { filename: 'prime-video-extractor.js' });

  const started = performance.now();
  let totalFound = 0;
  for (let index = 0; index < scanCount; index++) {
    totalFound += context.runtimeAuditExports.scanPrimeVideoEpisodeCatalog(document);
  }
  const elapsedMs = performance.now() - started;
  return {
    scanCount,
    cardCount,
    totalFound,
    catalogSize: state.primeVideoTitleMap.size,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    ...counts,
  };
}

async function runSkyShowtimeInterceptionScenario({ holdDirectFetch = false, rejectDirectJson = false }) {
  const targetUrl = 'https://atom.skyshowtime.com/adapter-calypso/v3/catalogue/provider_series_id/series-123';
  const counts = { originalRequests: 0, fallbackRequests: 0, responseClones: 0, responseJsonReads: 0 };
  let observerCallback = null;
  let resolveDirectFetch = null;
  const response = {
    clone() {
      counts.responseClones++;
      return {
        json() {
          counts.responseJsonReads++;
          return rejectDirectJson
            ? Promise.reject(new Error('synthetic direct response parse failure'))
            : Promise.resolve({});
        },
      };
    },
  };
  const originalFetch = () => {
    counts.originalRequests++;
    if (!holdDirectFetch) return Promise.resolve(response);
    return new Promise(resolve => { resolveDirectFetch = resolve; });
  };
  class FakePerformanceObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
  }
  const pageWindow = {
    fetch: originalFetch,
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: FakePerformanceObserver,
  };
  const state = { allItems: [], imdbId: '', imdbIdsByShowId: {}, showTitle: '', providerEpisodes: [] };
  const context = vm.createContext({
    state,
    window: pageWindow,
    unsafeWindow: pageWindow,
    document: { querySelector: () => null },
    location: { pathname: '/watch/playback/synthetic' },
    console: { log() {}, info() {}, warn() {}, error() {} },
    handleDetectedShow() {},
    recordExtractedSegments() {},
    setProviderEpisodeCatalog() {},
    GM_xmlhttpRequest() { counts.fallbackRequests++; },
  });
  let source = readSources([
    'src/providers/timestamp-logger.js',
    'src/providers/skyshowtime/extractor.js',
  ]);
  source += '\nglobalThis.runtimeAuditExports = { setupSkyShowtimeInterception };';
  vm.runInContext(source, context, { filename: 'skyshowtime-extractor.js' });
  context.runtimeAuditExports.setupSkyShowtimeInterception();

  const directRequest = pageWindow.fetch(targetUrl);
  if (holdDirectFetch) {
    if (!observerCallback) throw new Error('SkyShowtime resource observer was not registered');
    observerCallback({ getEntries: () => [{ name: targetUrl }] });
    resolveDirectFetch(response);
  }
  await directRequest;
  await new Promise(resolve => setImmediate(resolve));
  return counts;
}

async function benchmarkSkyShowtimeInterception() {
  return {
    directFetchResourceRace: await runSkyShowtimeInterceptionScenario({ holdDirectFetch: true }),
    directParseFailure: await runSkyShowtimeInterceptionScenario({ rejectDirectJson: true }),
  };
}

async function main() {
  const report = {
    sourceRoot,
    node: process.version,
    mousemoveBurst: benchmarkMousemoveBurst(),
    crunchyrollStablePage: benchmarkCrunchyrollPolls(),
    primeStableCatalog: benchmarkPrimeCatalogScans(),
    skyShowtimeInterception: await benchmarkSkyShowtimeInterception(),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
