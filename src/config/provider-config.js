/**
 * Provider configuration layer
 * Defines shared Netflix panel styling and provider-specific settings
 */

/**
 * Base configuration for all providers
 */
export const BASE_CONFIG = {
  INTRODB_BASE: 'https://api.introdb.app',
  IMDB_SUGGESTION_BASE: 'https://v3.sg.media-imdb.com',
};

/**
 * Netflix is the visual source of truth for every provider panel.
 * Provider configuration may only override button colors, provider-name color,
 * header/info-box text, and the info-box accent.
 */
export const PANEL_COLORS = {
  background: 'rgba(12,12,12,0.98)',
  panelBg: '#181818',
  border: '#2c2c2c',
  text: '#fff',
  textSecondary: '#777',
  textMuted: '#444',
  accent: '#E50914',
};

/**
 * Provider-specific configurations
 * Each provider can customize button colors, provider-name color, header branding,
 * and info-box copy/accent.
 */
export const PROVIDER_CONFIGS = {
  netflix: {
    name: 'Netflix',
    match: 'https://www.netflix.com/*',
    colors: {
      primary: '#E50914',
      primaryDark: '#b30812',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#E50914',
    infoAccent: '#E50914',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically.',
  },
  disneyplus: {
    name: 'Disney+',
    match: 'https://www.disneyplus.com/*',
    colors: {
      primary: '#0063e5',
      primaryDark: '#004bb3',
      secondary: '#0c734f',
      secondaryDark: '#095a3d',
    },
    nameColor: '#0063e5',
    infoAccent: '#0063e5',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically.',
  },
  'prime-video': {
    name: 'Prime Video',
    match: 'https://*.primevideo.com/*',
    colors: {
      primary: '#00A8E1',
      primaryDark: '#008fbe',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#00A8E1',
    infoAccent: '#00A8E1',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'Segments are fetched per episode, so all seasons and episodes must be checked.',
  },
  hbo: {
    name: 'HBO Max',
    match: 'https://play.max.com/*',
    colors: {
      primary: '#8a2be2',
      primaryDark: '#6a1b9e',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#8a2be2',
    infoAccent: '#8a2be2',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically.',
  },
  videoland: {
    name: 'Videoland',
    match: 'https://www.videoland.com/*',
    colors: {
      primary: '#e0303d',
      primaryDark: '#3C0919',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#e0303d',
    infoAccent: '#e0303d',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'Segments are fetched per episode, so all seasons and episodes must be checked.',
  },
  skyshowtime: {
    name: 'SkyShowtime',
    match: 'https://www.skyshowtime.com/*',
    colors: {
      primary: '#0072CE',
      primaryDark: '#005A9C',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
    },
    nameColor: '#0072CE',
    infoAccent: '#0072CE',
    branding: {
      title: 'SegmentScraper',
    },
    captureHint: 'All available seasons and episodes are captured automatically from SkyShowtime catalogue metadata.',
  },
};

/**
 * Get configuration for a specific provider
 * @param {string} providerName - The provider name
 * @returns {Object} - Provider configuration
 */
export function getProviderConfig(providerName) {
  return PROVIDER_CONFIGS[providerName.toLowerCase()] || PROVIDER_CONFIGS.netflix;
}

/**
 * Get all provider names
 * @returns {string[]} - Array of provider names
 */
export function getProviderNames() {
  return Object.keys(PROVIDER_CONFIGS);
}
