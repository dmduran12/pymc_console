import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from './ThemeContext';

/**
 * Hook to access theme state and actions.
 * Must be used within a ThemeProvider.
 * 
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { theme, setThemePreset, setBrightness } = useTheme();
 *   
 *   return (
 *     <div>
 *       <p>Current scheme: {theme.colorScheme}</p>
 *       <button onClick={() => setThemePreset('amber')}>Amber Theme</button>
 *       <input 
 *         type="range" 
 *         value={theme.brightness} 
 *         onChange={(e) => setBrightness(Number(e.target.value))} 
 *       />
 *     </div>
 *   );
 * }
 * ```
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  
  if (!context) {
    throw new Error(
      'useTheme must be used within a ThemeProvider. ' +
      'Wrap your app with <ThemeProvider> in App.tsx.'
    );
  }
  
  return context;
}

// Re-export types and config for convenience
export type { ThemeContextValue } from './ThemeContext';
export type { 
  ColorSchemeId, 
  ThemeState, 
  ThemePreset, 
  BackgroundImage,
  ColorScheme,
} from './theme-config';
export { 
  COLOR_SCHEMES, 
  BACKGROUND_IMAGES, 
  THEME_PRESETS,
  getColorScheme,
  getBackgroundImage,
  getThemePreset,
  preloadImage,
} from './theme-config';
