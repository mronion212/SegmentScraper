/** Videoland provider registration. */

import { bootstrapProvider } from '../bootstrap.js';
import { setupVideolandInterception } from './extractor.js';

bootstrapProvider({
  providerName: 'videoland',
  setupInterception: setupVideolandInterception,
});
