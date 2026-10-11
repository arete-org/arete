export const THEMES = [
  { value: 'pierre', label: 'PIERRE', color: '#F6F3ED', foreground: '#1C2927' },
  { value: 'prune', label: 'PRUNE', color: '#291E29', foreground: '#F2E8DA' },
  { value: 'light', label: 'CLAIR', color: '#F4F7FA', foreground: '#172B3A' },
  { value: 'dark', label: 'SOMBRE', color: '#0A0A0F', foreground: '#E8E8E8' },
  { value: 'darker', label: 'PLUS SOMBRE', color: '#050508', foreground: '#E8E8E8' },
  { value: 'abyss', label: 'ABYSSE', color: '#000000', foreground: '#E8E8E8' },
  { value: 'performance', label: 'PERFORMANCE', color: '#F4F5EF', foreground: '#17281E' },
  { value: 'odyssey', label: 'ODYSSEY', color: '#F5EBDD', foreground: '#3B3432' },
] as const;

export type Theme = (typeof THEMES)[number]['value'];
const STORAGE_KEY = 'arete.theme.v1';

export function applyTheme(theme: Theme) {
  const selected = THEMES.find((item) => item.value === theme) ?? THEMES.find(item => item.value === 'dark')!;
  document.documentElement.dataset.theme = selected.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected.color);
}

/** Cache only saved preferences so reloads never restore an abandoned preview. */
export function cacheTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (error) {
    console.warn('Could not cache the saved theme', error);
  }
}

export function initializeTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    applyTheme(THEMES.find((item) => item.value === saved)?.value ?? 'dark');
  } catch (error) {
    console.warn('Could not read the saved theme', error);
    applyTheme('dark');
  }
}
