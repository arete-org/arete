import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

// The theme toggle only ever switches between "light" and "dark" for now.
export type Theme = 'light' | 'dark';

// Public shape of our theme context so components can inspect or change the active mode.
interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (next: Theme) => void;
}

// Small helper to safely access localStorage in SSR/Node contexts.
const supportsLocalStorage = (): boolean => typeof window !== 'undefined' && !!window.localStorage;

// Dedicate a storage key so the preference persists between visits.
const STORAGE_KEY = 'daneel-theme-preference';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Determine the initial theme: stored preference wins, otherwise fall back to the OS preference.
const resolveInitialTheme = (): Theme => {
  if (supportsLocalStorage()) {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  }

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  return 'light';
};

export const ThemeProvider = ({ children }: PropsWithChildren): JSX.Element => {
  const [theme, setThemeState] = useState<Theme>(() => resolveInitialTheme());

  // Wrap setState so we can persist the preference and update the DOM attribute.
  const applyTheme = useCallback((next: Theme) => {
    setThemeState(next);

    if (supportsLocalStorage()) {
      window.localStorage.setItem(STORAGE_KEY, next);
    }

    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
  }, []);

  // Ensure the attribute and storage value are in sync on mount.
  useEffect(() => {
    applyTheme(theme);
    // We intentionally only want to run this on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to system preference changes when the user has not explicitly chosen a side.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => {
      if (!supportsLocalStorage() || !window.localStorage.getItem(STORAGE_KEY)) {
        applyTheme(event.matches ? 'dark' : 'light');
      }
    };

    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [applyTheme]);

  const toggleTheme = useCallback(() => {
    applyTheme(theme === 'light' ? 'dark' : 'light');
  }, [applyTheme, theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    toggleTheme,
    setTheme: applyTheme,
  }), [applyTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }

  return context;
};
