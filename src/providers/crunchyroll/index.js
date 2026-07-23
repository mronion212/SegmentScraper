/** Crunchyroll provider registration. */

import { bootstrapProvider } from '../bootstrap.js';
import { isCrunchyrollPlayerPage, setupCrunchyrollInterception } from './extractor.js';

bootstrapProvider({
  providerName: 'crunchyroll',
  setupInterception: setupCrunchyrollInterception,
  isPlayerPage: isCrunchyrollPlayerPage,
});
