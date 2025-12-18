import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type ColorSchemeId,
  type ThemeState,
  DEFAULT_THEME_STATE,
  STORAGE_KEYS,
  THEME_PRESETS,
  BACKGROUND_IMAGES,
  getColorScheme,
  isValidColorScheme,
} from './theme-config';

// ─────────────────────────────────────────────────────────────────────────────
// Context Type
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeContextValue {
  /** Current theme state */
  theme: ThemeState;
  /** Set the color scheme (CSS theme) */
  setColorScheme: (scheme: ColorSchemeId) => void;
  /** Set the background image URL */
  setBackgroundImage: (src: string) => void;
  /** Set the brightness (0-100) */
  setBrightness: (value: number) => void;
  /** Apply a preset theme (sets both color scheme and background) */
  setThemePreset: (presetId: string) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

// ─────────────────────────────────────────────────────────────────────────────
// localStorage Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadThemeFromStorage(): ThemeState {
  if (typeof window === 'undefined') return DEFAULT_THEME_STATE;

  try {
    // Try new keys first
    let colorScheme = localStorage.getItem(STORAGE_KEYS.colorScheme);
    let backgroundImage = localStorage.getItem(STORAGE_KEYS.backgroundImage);
    const brightnessStr = localStorage.getItem(STORAGE_KEYS.brightness);

    // Migration: if new keys don't exist, try legacy key
    if (!colorScheme && !backgroundImage) {
      const legacyValue = localStorage.getItem(STORAGE_KEYS.legacyBackground);
      if (legacyValue) {
        // Legacy format stored the preset ID (e.g., 'amber')
        // which maps to both color scheme and background
        const preset = THEME_PRESETS.find(p => p.id === legacyValue);
        if (preset) {
          colorScheme = preset.colorScheme;
          backgroundImage = preset.backgroundImage;
          // Migrate to new keys
          localStorage.setItem(STORAGE_KEYS.colorScheme, colorScheme);
          localStorage.setItem(STORAGE_KEYS.backgroundImage, backgroundImage);
          // Remove legacy key
          localStorage.removeItem(STORAGE_KEYS.legacyBackground);
        }
      }
    }

    // Validate and parse
    const validColorScheme = isValidColorScheme(colorScheme) ? colorScheme : DEFAULT_THEME_STATE.colorScheme;
    const validBackgroundImage = backgroundImage || DEFAULT_THEME_STATE.backgroundImage;
    
    let brightness = DEFAULT_THEME_STATE.brightness;
    if (brightnessStr) {
      const parsed = parseInt(brightnessStr, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        brightness = parsed;
      }
    }

    return {
      colorScheme: validColorScheme,
      backgroundImage: validBackgroundImage,
      brightness,
    };
  } catch {
    // localStorage not available (SSR, incognito, etc.)
    return DEFAULT_THEME_STATE;
  }
}

function saveThemeToStorage(theme: ThemeState): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEYS.colorScheme, theme.colorScheme);
    localStorage.setItem(STORAGE_KEYS.backgroundImage, theme.backgroundImage);
    localStorage.setItem(STORAGE_KEYS.brightness, String(theme.brightness));
  } catch {
    // Ignore storage errors
  }
}

function applyColorSchemeToDOM(scheme: ColorSchemeId): void {
  const colorScheme = getColorScheme(scheme);
  if (colorScheme.dataTheme) {
    document.documentElement.setAttribute('data-theme', colorScheme.dataTheme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  console.log('[Theme] Color scheme applied:', scheme, colorScheme.dataTheme ? `(data-theme="${colorScheme.dataTheme}")` : '(default)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Component
// ─────────────────────────────────────────────────────────────────────────────

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // Initialize state from localStorage
  const [theme, setTheme] = useState<ThemeState>(() => loadThemeFromStorage());

  // Sync color scheme to DOM on mount and changes
  useEffect(() => {
    applyColorSchemeToDOM(theme.colorScheme);
  }, [theme.colorScheme]);

  // Persist to localStorage on changes (debounced for brightness)
  useEffect(() => {
    saveThemeToStorage(theme);
  }, [theme]);

  // Preload all background images on mount for instant switching
  useEffect(() => {
    BACKGROUND_IMAGES.forEach(bg => {
      const img = new Image();
      img.src = bg.src;
    });
  }, []);

  // Actions
  const setColorScheme = useCallback((scheme: ColorSchemeId) => {
    console.log('[Theme] setColorScheme:', scheme);
    setTheme(prev => ({ ...prev, colorScheme: scheme }));
  }, []);

  const setBackgroundImage = useCallback((src: string) => {
    console.log('[Theme] setBackgroundImage:', src);
    setTheme(prev => ({ ...prev, backgroundImage: src }));
  }, []);

  const setBrightness = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    setTheme(prev => ({ ...prev, brightness: clamped }));
  }, []);

  const setThemePreset = useCallback((presetId: string) => {
    const preset = THEME_PRESETS.find(p => p.id === presetId);
    if (preset) {
      console.log('[Theme] setThemePreset:', presetId, '→', { colorScheme: preset.colorScheme, backgroundImage: preset.backgroundImage });
      setTheme(prev => ({
        ...prev,
        colorScheme: preset.colorScheme,
        backgroundImage: preset.backgroundImage,
      }));
    }
  }, []);

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setColorScheme,
      setBackgroundImage,
      setBrightness,
      setThemePreset,
    }),
    [theme, setColorScheme, setBackgroundImage, setBrightness, setThemePreset]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}
