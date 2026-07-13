/**
 * Build bundler for SegmentScraper
 * Concatenates ES modules into a single userscript-compatible file
 * Handles import/export resolution and code transformation
 */

const fs = require('fs');
const path = require('path');

// Userscript header template
const USERSCRIPT_HEADER = `// ==UserScript==
// @name         SegmentScraper - Multi-Provider Timestamps Extractor
// @namespace    https://github.com/mronion212/SegmentScraper
// @version      1.0.0
// @description  Extracts intro/recap/outro timestamps from streaming services. Auto IMDb lookup. Submits to IntroDB with deduplication.
// @author       mronion212
// @match        https://www.netflix.com/*
// @match        https://www.disneyplus.com/*
// @match        https://www.amazon.com/*/detail/*
// @match        https://play.max.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      v3.sg.media-imdb.com
// @connect      api.introdb.app
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';
  const _GM_xmlhttpRequest = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null;
  const _unsafeWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

`;

/**
 * Read a source file and return its content
 */
function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Transform ES module code to userscript-compatible code
 * - Removes import statements
 * * Converts export statements to regular declarations
 */
function transformCode(content) {
  // Remove import statements (entire line)
  content = content.replace(/^\s*import\s+[^;]+;?\s*$/gm, '');
  
  // Convert "export async function" to "async function" (must be before export function)
  content = content.replace(/^(\s*)export\s+async\s+function\s+/gm, '$1async function ');
  
  // Convert "export function" to "function"
  content = content.replace(/^(\s*)export\s+function\s+/gm, '$1function ');
  
  // Convert "export const" to "const"
  content = content.replace(/^(\s*)export\s+const\s+/gm, '$1const ');
  
  // Convert "export let" to "let"
  content = content.replace(/^(\s*)export\s+let\s+/gm, '$1let ');
  
  // Convert "export var" to "var"
  content = content.replace(/^(\s*)export\s+var\s+/gm, '$1var ');
  
  // Convert "export class" to "class"
  content = content.replace(/^(\s*)export\s+class\s+/gm, '$1class ');
  
  // Remove "export {" lines
  content = content.replace(/^\s*export\s+\{[^}]+\}\s*$/gm, '');
  
  // Remove "export default" 
  content = content.replace(/^(\s*)export\s+default\s+/gm, '$1const defaultExport = ');
  
  return content;
}

/**
 * Bundle all source files into a single userscript
 */
function bundle() {
  const srcDir = path.join(__dirname, '..', 'src');
  const outputFile = path.join(__dirname, '..', 'SegmentScraper.user.js');
  
  // Define file order for proper dependency resolution
  const fileOrder = [
    'core/state.js',
    'core/network.js',
    'config/provider-config.js',
    'normalization/segment-mapper.js',
    'ui/panel.js',
    'ui/button.js',
    'providers/netflix/extractor.js',
    'providers/netflix/index.js',
  ];
  
  // Transform and concatenate all files
  let bundledCode = USERSCRIPT_HEADER;
  
  for (const relativePath of fileOrder) {
    const file = path.join(srcDir, relativePath);
    if (fs.existsSync(file)) {
      console.log(`Bundling: ${relativePath}`);
      const content = readFile(file);
      const transformed = transformCode(content);
      
      bundledCode += `\n  // ─── ${relativePath} ───\n\n`;
      bundledCode += transformed;
      bundledCode += '\n';
    }
  }
  
  // Close the IIFE
  bundledCode += '})();\n';
  
  // Write output
  fs.writeFileSync(outputFile, bundledCode, 'utf8');
  console.log(`\nBundled userscript written to: ${outputFile}`);
  console.log(`Total size: ${bundledCode.length} bytes`);
}

// Run bundler
bundle();