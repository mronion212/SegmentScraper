/** Netflix provider registration. */

import { bootstrapProvider } from '../bootstrap.js';
import { setupNetflixInterception } from './extractor.js';

bootstrapProvider({
  providerName: 'netflix',
  setupInterception: setupNetflixInterception,
  isPlayerPage: () => location.pathname.startsWith('/watch'),
});
