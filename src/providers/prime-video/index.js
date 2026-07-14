/** Prime Video provider registration. */

import { bootstrapProvider } from '../bootstrap.js';
import { setupPrimeVideoInterception } from './extractor.js';

bootstrapProvider({
  providerName: 'prime-video',
  setupInterception: setupPrimeVideoInterception,
});
