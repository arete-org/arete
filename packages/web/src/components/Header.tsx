/**
 * @description: Renders the sticky site header, navigation actions, breadcrumbs, and theme toggle.
 * @footnote-scope: web
 * @footnote-module: SiteHeader
 * @footnote-risk: low - Header regressions mostly affect navigation and discoverability across the site.
 * @footnote-ethics: low - Navigation clarity supports transparency, but this component does not process sensitive content.
 */

/**
 * Header component displays the site header with Footnote title, breadcrumb trail, navigation buttons, and theme toggle.
 * This header is sticky and follows the user as they scroll, providing consistent navigation.
 */
import { Link, useLocation } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';

interface BreadcrumbItem {
    label: string;
    path?: string;
}

interface HeaderProps {
    breadcrumbItems?: BreadcrumbItem[];
}

interface NavItem {
    label: string;
    to: string;
    isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
    {
        label: 'Download',
        to: '/download',
        isActive: (pathname) => pathname.startsWith('/download'),
    },
    {
        label: 'Docs',
        to: '/about',
        isActive: (pathname) => pathname.startsWith('/about'),
    },
    {
        label: 'Blog',
        to: '/blog',
        isActive: (pathname) => pathname.startsWith('/blog'),
    },
    {
        label: 'Contributing',
        to: '/onboarding',
        isActive: (pathname) => pathname.startsWith('/onboarding'),
    },
];

const Header = ({
    breadcrumbItems: _breadcrumbItems,
}: HeaderProps): JSX.Element => {
    const location = useLocation();
    const pathname = location.pathname;

    const openInNewTab = pathname === '/embed';

    return (
        <header className="site-header-sticky" aria-label="Site header">
            <div className="site-header-sticky__inner">
                <div className="site-title-group">
                    <Link to="/" className="site-mark-link">
                        <p className="site-mark">Footnote</p>
                    </Link>
                </div>
                <div className="site-header-actions">
                    <nav className="site-nav" aria-label="Primary">
                        <ul className="site-nav__list">
                            {NAV_ITEMS.map((item) => {
                                const isActive = item.isActive(pathname);
                                return (
                                    <li
                                        key={item.to}
                                        className="site-nav__item"
                                    >
                                        <Link
                                            className="site-nav__link"
                                            to={item.to}
                                            aria-current={
                                                isActive ? 'page' : undefined
                                            }
                                            {...(openInNewTab
                                                ? {
                                                      target: '_blank',
                                                      rel: 'noopener noreferrer',
                                                  }
                                                : {})}
                                        >
                                            {item.label}
                                            {openInNewTab && (
                                                <>
                                                    {' '}
                                                    <span aria-hidden="true">
                                                        ↗
                                                    </span>
                                                </>
                                            )}
                                        </Link>
                                    </li>
                                );
                            })}
                            <li className="site-nav__item">
                                <a
                                    className="site-nav__link site-nav__link--icon"
                                    href="https://github.com/footnote-ai/footnote"
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label="Source on GitHub"
                                >
                                    <svg
                                        aria-hidden="true"
                                        viewBox="0 0 24 24"
                                        width="16"
                                        height="16"
                                    >
                                        <path
                                            fill="currentColor"
                                            d="M12 .5A11.5 11.5 0 0 0 .5 12.2c0 5.23 3.39 9.68 8.1 11.25.6.12.82-.27.82-.58v-2.25c-3.29.73-3.98-1.63-3.98-1.63-.54-1.41-1.33-1.79-1.33-1.79-1.08-.76.08-.75.08-.75 1.2.09 1.83 1.26 1.83 1.26 1.06 1.87 2.79 1.33 3.47 1.01.11-.79.42-1.33.76-1.64-2.62-.31-5.37-1.35-5.37-6a4.76 4.76 0 0 1 1.23-3.32 4.43 4.43 0 0 1 .12-3.27s1.01-.33 3.3 1.27a11.19 11.19 0 0 1 6 0c2.29-1.6 3.3-1.27 3.3-1.27.45 1.03.5 2.22.12 3.27a4.76 4.76 0 0 1 1.23 3.32c0 4.66-2.76 5.68-5.39 5.98.43.38.81 1.11.81 2.25v3.34c0 .33.22.71.83.58a11.72 11.72 0 0 0 8.09-11.25A11.5 11.5 0 0 0 12 .5Z"
                                        />
                                    </svg>
                                </a>
                            </li>
                        </ul>
                    </nav>
                    <div
                        className="site-header-theme-toggle"
                        aria-label="Theme controls"
                    >
                        <ThemeToggle />
                    </div>
                </div>
            </div>
        </header>
    );
};

export default Header;
