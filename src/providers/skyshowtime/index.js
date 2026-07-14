/** SkyShowtime provider registration. */

import { bootstrapProvider } from '../bootstrap.js';
import { isSkyShowtimePlayerPage, setupSkyShowtimeInterception } from './extractor.js';

bootstrapProvider({
  providerName: 'skyshowtime',
  setupInterception: setupSkyShowtimeInterception,
  isPlayerPage: isSkyShowtimePlayerPage,
});
