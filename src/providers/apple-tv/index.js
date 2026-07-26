/** Apple TV provider registration. */

import { bootstrapProvider } from '../bootstrap.js';
import { setupAppleTvInterception } from './extractor.js';

bootstrapProvider({
  providerName: 'apple-tv',
  setupInterception: setupAppleTvInterception,
});
