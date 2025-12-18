/**
 * Theme Configuration
 * 
 * Defines color schemes and background images as separate, decoupled concepts.
 * This allows users to mix any color scheme with any background.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Color Schemes
// These correspond to CSS [data-theme="..."] selectors in index.css
// ─────────────────────────────────────────────────────────────────────────────

export type ColorSchemeId = 'default' | 'amber' | 'grey' | 'black' | 'flora';

export interface ColorScheme {
  id: ColorSchemeId;
  name: string;
  /** CSS data-theme attribute value (null = no attribute, uses :root defaults) */
  dataTheme: string | null;
  /** Preview color for UI (primary accent) */
  previewColor: string;
}

export const COLOR_SCHEMES: readonly ColorScheme[] = [
  { id: 'default', name: 'Lavender', dataTheme: null, previewColor: '#B49DFF' },
  { id: 'amber', name: 'Amber', dataTheme: 'amber', previewColor: '#FFB347' },
  { id: 'grey', name: 'Steel', dataTheme: 'grey', previewColor: '#8B9DC3' },
  { id: 'black', name: 'Neon', dataTheme: 'black', previewColor: '#00D4FF' },
  { id: 'flora', name: 'Flora', dataTheme: 'flora', previewColor: '#7DD3A8' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Background Images
// ─────────────────────────────────────────────────────────────────────────────

export interface BackgroundImage {
  id: string;
  src: string;
  /** Suggested color scheme that pairs well with this image */
  suggestedScheme: ColorSchemeId;
}

export const BACKGROUND_IMAGES: readonly BackgroundImage[] = [
  { id: 'default', src: '/assets/bg.jpg', suggestedScheme: 'default' },
  { id: 'amber', src: '/assets/bg-amber.jpg', suggestedScheme: 'amber' },
  { id: 'grey', src: '/assets/bg-grey.jpg', suggestedScheme: 'grey' },
  { id: 'black', src: '/assets/bg-black.jpg', suggestedScheme: 'black' },
  { id: 'flora', src: '/assets/bg-flora.jpg', suggestedScheme: 'flora' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Theme Presets (Color + Background combinations)
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemePreset {
  id: string;
  name: string;
  colorScheme: ColorSchemeId;
  backgroundImage: string;
}

/** Pre-configured theme combinations for quick selection */
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'default', name: 'Default', colorScheme: 'default', backgroundImage: '/assets/bg.jpg' },
  { id: 'amber', name: 'Amber', colorScheme: 'amber', backgroundImage: '/assets/bg-amber.jpg' },
  { id: 'grey', name: 'Steel', colorScheme: 'grey', backgroundImage: '/assets/bg-grey.jpg' },
  { id: 'black', name: 'Neon', colorScheme: 'black', backgroundImage: '/assets/bg-black.jpg' },
  { id: 'flora', name: 'Flora', colorScheme: 'flora', backgroundImage: '/assets/bg-flora.jpg' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Theme State
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeState {
  colorScheme: ColorSchemeId;
  backgroundImage: string;
  brightness: number; // 0-100, default 80
}

export const DEFAULT_THEME_STATE: ThemeState = {
  colorScheme: 'default',
  backgroundImage: '/assets/bg.jpg',
  brightness: 80,
};

// ─────────────────────────────────────────────────────────────────────────────
// localStorage Keys
// ─────────────────────────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  colorScheme: 'pymc-color-scheme',
  backgroundImage: 'pymc-background-image',
  brightness: 'pymc-bg-brightness',
  // Legacy key for migration
  legacyBackground: 'pymc-background',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getColorScheme(id: ColorSchemeId): ColorScheme {
  return COLOR_SCHEMES.find(s => s.id === id) ?? COLOR_SCHEMES[0];
}

export function getBackgroundImage(id: string): BackgroundImage {
  return BACKGROUND_IMAGES.find(b => b.id === id) ?? BACKGROUND_IMAGES[0];
}

export function getThemePreset(id: string): ThemePreset {
  return THEME_PRESETS.find(p => p.id === id) ?? THEME_PRESETS[0];
}

export function isValidColorScheme(id: unknown): id is ColorSchemeId {
  return typeof id === 'string' && COLOR_SCHEMES.some(s => s.id === id);
}

export function isValidBackgroundImage(src: unknown): boolean {
  return typeof src === 'string' && BACKGROUND_IMAGES.some(b => b.src === src);
}

/** Preload an image to browser cache */
export function preloadImage(src: string): void {
  const img = new Image();
  img.src = src;
}

/** Preload all background images */
export function preloadAllBackgrounds(): void {
  BACKGROUND_IMAGES.forEach(bg => preloadImage(bg.src));
}
