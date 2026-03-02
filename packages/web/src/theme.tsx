/**
 * @description: Provides the web theme context, persistence, and DOM synchronization for light and dark mode.
 * @footnote-scope: web
 * @footnote-module: WebThemeProvider
 * @footnote-risk: low - Theme state bugs affect presentation but do not corrupt core application data.
 * @footnote-ethics: low - Theme behavior influences accessibility expectations but does not process sensitive content.
 */

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
const supportsLocalStorage = (): boolean =>
    typeof window !== 'undefined' && !!window.localStorage;

// Dedicate a storage key so the preference persists between visits.
const STORAGE_KEY = 'footnote-theme-preference';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Determine the initial theme: stored preference wins, otherwise we deliberately start in light mode.
// Designers asked for the light palette to be the first impression regardless of OS preference so the
// brand feels consistent on every new visit.
const resolveInitialTheme = (): Theme => {
    if (supportsLocalStorage()) {
        const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
        if (stored === 'light' || stored === 'dark') {
            return stored;
        }
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
            if (
                !supportsLocalStorage() ||
                !window.localStorage.getItem(STORAGE_KEY)
            ) {
                applyTheme(event.matches ? 'dark' : 'light');
            }
        };

        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
    }, [applyTheme]);

    const toggleTheme = useCallback(() => {
        setThemeState((currentTheme) => {
            const nextTheme = currentTheme === 'light' ? 'dark' : 'light';

            // Apply theme immediately
            if (supportsLocalStorage()) {
                window.localStorage.setItem(STORAGE_KEY, nextTheme);
            }

            if (typeof document !== 'undefined') {
                document.documentElement.setAttribute('data-theme', nextTheme);
            }

            return nextTheme;
        });
    }, []);

    const value = useMemo<ThemeContextValue>(
        () => ({
            theme,
            toggleTheme,
            setTheme: applyTheme,
        }),
        [applyTheme, theme, toggleTheme]
    );

    return (
        <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
    );
};

export const useTheme = (): ThemeContextValue => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used inside a ThemeProvider');
    }

    return context;
};
