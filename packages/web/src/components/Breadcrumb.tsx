/**
 * Breadcrumb component displays navigation trail for blog and invite pages.
 * Shows current page and provides links back to parent pages and home.
 */
import { Link } from 'react-router-dom';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

const Breadcrumb = ({ items }: BreadcrumbProps): JSX.Element => {
  if (items.length === 0) {
    return <></>;
  }

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb navigation">
      <ol className="breadcrumb__list">
        {items.map((item, index) => (
          <li key={index} className="breadcrumb__item">
            {item.path ? (
              <Link to={item.path} className="breadcrumb__link">
                {item.label}
              </Link>
            ) : (
              <span className="breadcrumb__current" aria-current="page">
                {item.label}
              </span>
            )}
            {index < items.length - 1 && (
              <span className="breadcrumb__separator" aria-hidden="true">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
};

export default Breadcrumb;
