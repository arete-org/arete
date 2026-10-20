/** The palettes in index.css. `color` and `foreground` draw the picker's previews. */
export const THEMES = [
  { value: 'pierre', label: 'Pierre', color: '#F6F3ED', foreground: '#1C2927' },
  { value: 'prune', label: 'Prune', color: '#291E29', foreground: '#F2E8DA' },
  { value: 'odyssey', label: 'Odyssey', color: '#F5EBDD', foreground: '#3B3432' },
  { value: 'encre', label: 'Encre', color: '#0E1413', foreground: '#F2E8DA' },
] as const;

export type Theme = (typeof THEMES)[number]['value'];
/** What the athlete chooses: a palette, or « Système », which follows the device. */
export type ThemePreference = Theme | 'system';

export const SYSTEM_THEMES = { light: 'pierre', dark: 'encre' } as const satisfies Record<string, Theme>;
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/** Themes retired by ARE-134: a saved one moves once to the closest kept palette. */
const LEGACY_THEMES: Record<string, Theme> = {
  light: 'pierre',
  performance: 'pierre',
  dark: 'encre',
  darker: 'encre',
  abyss: 'encre',
};

const STORAGE_KEY = 'arete.theme.v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const isTheme = (value: unknown): value is Theme => THEMES.some((item) => item.value === value);

/** A saved or received value as a current preference; anything unknown follows the device. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  if (value === 'system' || isTheme(value)) return value;
  if (typeof value === 'string' && value in LEGACY_THEMES) return LEGACY_THEMES[value];
  return DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference !== 'system') return preference;
  return prefersDark ? SYSTEM_THEMES.dark : SYSTEM_THEMES.light;
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
}

let applied: ThemePreference = DEFAULT_THEME_PREFERENCE;
let following: MediaQueryList | null = null;

function paint() {
  const theme = resolveTheme(applied, darkQuery()?.matches ?? false);
  const selected = THEMES.find((item) => item.value === theme)!;
  document.documentElement.dataset.theme = selected.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected.color);
}

/** Shows a preference; « Système » keeps following the device until another is applied. */
export function applyTheme(preference: ThemePreference | string) {
  applied = normalizeThemePreference(preference);
  if (applied === 'system' && !following) {
    following = darkQuery();
    following?.addEventListener('change', paint);
  } else if (applied !== 'system' && following) {
    following.removeEventListener('change', paint);
    following = null;
  }
  paint();
}

/** Cache only saved preferences so reloads never restore an abandoned preview. */
export function cacheTheme(preference: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch (error) {
    console.warn('Could not cache the saved theme', error);
  }
}

/** Before the first render: the cached preference, a retired one migrated once. */
export function initializeTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Could not read the saved theme', error);
  }
  const preference = saved === null ? DEFAULT_THEME_PREFERENCE : normalizeThemePreference(saved);
  if (saved !== null && saved !== preference) cacheTheme(preference);
  applyTheme(preference);
}
