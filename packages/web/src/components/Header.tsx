/**
 * Header component displays the site header with ARETE title, breadcrumb trail, navigation buttons, and theme toggle.
 * This header is sticky and follows the user as they scroll, providing consistent navigation.
 */
import { Link, useLocation } from 'react-router-dom';
import Breadcrumb from './Breadcrumb';
import ThemeToggle from './ThemeToggle';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface HeaderProps {
  breadcrumbItems: BreadcrumbItem[];
}

const Header = ({ breadcrumbItems }: HeaderProps): JSX.Element => {
  const location = useLocation();
  const pathname = location.pathname;
  
  // Hide Setup button on setup/invite page
  const showSetupButton = !pathname.startsWith('/invite');
  
  // Hide Blog button on blog pages
  const showBlogButton = !pathname.startsWith('/blog');
  
  return (
    <header className="site-header-sticky" aria-label="Site header">
      <div className="site-header-sticky__inner">
        <div className="site-title-group">
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <p className="site-mark">ARETE</p>
          </Link>
          <Breadcrumb items={breadcrumbItems} />
        </div>
        <div className="site-header-actions">
          {showSetupButton && (
            <a className="header-button secondary" href="/invite/">
              Setup
            </a>
          )}
          {showBlogButton && (
            <a className="header-button secondary" href="/blog">
              Blog
            </a>
          )}
          <a className="header-button secondary" href="https://github.com/arete-org/arete" target="_blank" rel="noreferrer" aria-label="View ARETE project on GitHub (opens in new tab)">
            GitHub <span aria-hidden="true">↗</span>
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
};

export default Header;

