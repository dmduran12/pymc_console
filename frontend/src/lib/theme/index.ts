// Theme system public API
export { ThemeProvider } from './ThemeContext';
export { useTheme } from './use-theme';

// Re-export types
export type {
  ColorSchemeId,
  ColorScheme,
  BackgroundImage,
  ThemePreset,
  ThemeState,
} from './theme-config';

// Re-export config constants
export {
  COLOR_SCHEMES,
  BACKGROUND_IMAGES,
  THEME_PRESETS,
  DEFAULT_THEME_STATE,
  STORAGE_KEYS,
  getColorScheme,
  getBackgroundImage,
  getThemePreset,
  preloadImage,
  preloadAllBackgrounds,
} from './theme-config';
