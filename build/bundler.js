/**
 * Build bundler for SegmentScraper
 * Concatenates ES modules into a single userscript-compatible file
 * Handles import/export resolution and code transformation
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const SCRIPT_VERSION = packageMetadata.version;
const UPDATE_URL = 'https://raw.githubusercontent.com/mronion212/SegmentScraper/main/SegmentScraper.user.js';

// Userscript header template. Keep @name and @namespace stable across releases;
// only @version should change.
const USERSCRIPT_HEADER = `// ==UserScript==
// @name         SegmentScraper - Multi-Provider Timestamps Extractor
// @version      ${SCRIPT_VERSION}
// @namespace    https://github.com/mronion212/SegmentScraper
// @description  Extracts intro/recap/outro timestamps from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.
// @author       mronion212
// @homepageURL  https://github.com/mronion212/SegmentScraper
// @updateURL    ${UPDATE_URL}
// @downloadURL  ${UPDATE_URL}
// @match        https://www.netflix.com/*
// @match        https://www.disneyplus.com/*
// @match        https://www.primevideo.com/*
// @match        https://www.amazon.*/gp/video/*
// @match        https://*.primevideo.com/*
// @match        https://www.videoland.com/*
// @match        https://videoland.com/*
// @match        https://v2.videoland.com/*
// @match        https://*.videoland.com/*
// @match        https://play.max.com/*
// @match        https://www.skyshowtime.com/*
// @match        https://skyshowtime.com/*
// @match        https://www.crunchyroll.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      v3.sg.media-imdb.com
// @connect      api.introdb.app
// @connect      api4.thetvdb.com
// @connect      atom.skyshowtime.com
// @connect      static.crunchyroll.com
// @connect      raw.githubusercontent.com
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';
  const _GM_xmlhttpRequest = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null;
  const SEGMENTSCRAPER_VERSION = ${JSON.stringify(SCRIPT_VERSION)};
  const SEGMENTSCRAPER_UPDATE_URL = ${JSON.stringify(UPDATE_URL)};

`;

/**
 * Read a source file and return its content
 */
function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

/**
 * Transform ES module code to userscript-compatible code
 * - Removes import statements
 * - Converts export statements to regular declarations
 */
function transformCode(content) {
  const transformed = content
    .replace(/^[ \t]*import[ \t]+[^\n]*;[ \t]*(?:\n|$)/gm, '')
    .replace(/^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?(?:function|const|let|var|class)\b)/gm, '$1')
    .replace(/^[ \t]*export[ \t]*\{[^}\n]+\};?[ \t]*\n?/gm, '')
    .replace(/^([ \t]*)export[ \t]+default[ \t]+/gm, '$1const defaultExport = ')
    .trim();

  return transformed;
}

function transformSource(srcDir, relativePath) {
  console.log(`Bundling: ${relativePath}`);
  return transformCode(readFile(path.join(srcDir, relativePath)));
}

/**
 * Bundle all source files into a single userscript
 */
function bundle() {
  const srcDir = path.join(__dirname, '..', 'src');
  const outputFile = path.join(__dirname, '..', 'SegmentScraper.user.js');
  
  // Define file order for proper dependency resolution
  const commonFileOrder = [
    'core/state.js',
    'core/update-check.js',
    'core/network.js',
    'core/introdb-settings.js',
    'core/tvdb.js',
    'config/provider-config.js',
    'normalization/segment-mapper.js',
    'providers/timestamp-logger.js',
    'ui/panel.js',
    'ui/button.js',
    'providers/bootstrap.js',
  ];

  const providerBundles = [
    {
      condition: "location.hostname === 'www.netflix.com' || location.hostname === 'netflix.com'",
      files: ['providers/netflix/extractor.js', 'providers/netflix/index.js'],
    },
    {
      condition: "location.hostname === 'primevideo.com' || location.hostname.endsWith('.primevideo.com') || (/^www\\.amazon\\./i.test(location.hostname) && location.pathname.startsWith('/gp/video/'))",
      files: ['providers/prime-video/extractor.js', 'providers/prime-video/index.js'],
    },
    {
      condition: "location.hostname === 'videoland.com' || location.hostname.endsWith('.videoland.com')",
      files: ['providers/videoland/extractor.js', 'providers/videoland/index.js'],
    },
    {
      condition: "location.hostname === 'skyshowtime.com' || location.hostname.endsWith('.skyshowtime.com')",
      files: ['providers/skyshowtime/extractor.js', 'providers/skyshowtime/index.js'],
    },
    {
      condition: "location.hostname === 'crunchyroll.com' || location.hostname.endsWith('.crunchyroll.com')",
      files: ['providers/crunchyroll/extractor.js', 'providers/crunchyroll/index.js'],
    },
  ];
  
  // Transform and concatenate all files
  let bundledCode = USERSCRIPT_HEADER;
  
  for (const relativePath of commonFileOrder) {
    bundledCode += `\n${transformSource(srcDir, relativePath)}\n`;
  }

  for (const provider of providerBundles) {
    bundledCode += `\n  if (${provider.condition}) {\n`;
    for (const relativePath of provider.files) {
      bundledCode += `\n${transformSource(srcDir, relativePath)}\n`;
    }
    bundledCode += '  }\n';
  }
  
  // Close the IIFE
  bundledCode += '})();\n';

  new vm.Script(bundledCode, { filename: path.basename(outputFile) });

  // Write output
  fs.writeFileSync(outputFile, bundledCode, 'utf8');
  console.log(`\nBundled userscript written to: ${outputFile}`);
  console.log(`Total size: ${Buffer.byteLength(bundledCode, 'utf8')} bytes`);
}

// Run bundler
bundle();
