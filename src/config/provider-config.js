/**
 * Provider configuration layer
 * Defines UI themes, branding, and service-specific settings
 */

/**
 * Base configuration for all providers
 */
export const BASE_CONFIG = {
  INTRODB_BASE: 'https://api.introdb.app',
  IMDB_SUGGESTION_BASE: 'https://v3.sg.media-imdb.com',
};

/**
 * Provider-specific configurations
 * Each provider can customize colors, branding, and behavior
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
      background: 'rgba(12,12,12,0.98)',
      panelBg: '#181818',
      border: '#2c2c2c',
      text: '#fff',
      textSecondary: '#777',
      textMuted: '#444',
    },
    branding: {
      icon: '🎬',
      title: 'Timestamps Extractor',
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
      background: 'rgba(15, 23, 33, 0.98)',
      panelBg: '#1a2634',
      border: '#2a3a4a',
      text: '#fff',
      textSecondary: '#888',
      textMuted: '#555',
    },
    branding: {
      icon: '🏰',
      title: 'Timestamps Extractor',
    },
    captureHint: 'Browse seasons and episodes to capture available timestamps.',
  },
  amazon: {
    name: 'Prime Video',
    match: 'https://www.amazon.com/*/detail/*',
    colors: {
      primary: '#ff9900',
      primaryDark: '#e68a00',
      secondary: '#0f79af',
      secondaryDark: '#0c5d86',
      background: 'rgba(18, 27, 36, 0.98)',
      panelBg: '#222f3d',
      border: '#334455',
      text: '#fff',
      textSecondary: '#999',
      textMuted: '#666',
    },
    branding: {
      icon: '📺',
      title: 'Timestamps Extractor',
    },
    captureHint: 'Browse seasons and episodes to capture available timestamps.',
  },
  hbo: {
    name: 'HBO Max',
    match: 'https://play.max.com/*',
    colors: {
      primary: '#8a2be2',
      primaryDark: '#6a1b9e',
      secondary: '#1565c0',
      secondaryDark: '#0d47a1',
      background: 'rgba(18, 18, 18, 0.98)',
      panelBg: '#222222',
      border: '#333333',
      text: '#fff',
      textSecondary: '#888',
      textMuted: '#555',
    },
    branding: {
      icon: '🎭',
      title: 'Timestamps Extractor',
    },
    captureHint: 'Browse seasons and episodes to capture available timestamps.',
  },
  videoland: {
    name: 'Videoland',
    match: 'https://www.videoland.com/*',
    colors: {
      primary: '#f15a24',
      primaryDark: '#c9481a',
      secondary: '#d84d1d',
      secondaryDark: '#ad3d17',
      background: 'rgba(18,18,18,0.98)',
      panelBg: '#242424',
      border: '#3a3a3a',
      text: '#fff',
      textSecondary: '#999',
      textMuted: '#666',
    },
    branding: {
      icon: '📺',
      title: 'Timestamps Extractor',
    },
    captureHint: 'Browse seasons and episodes to capture available timestamps.',
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
