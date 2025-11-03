/**
 * BlogPostCard component displays a preview card for a blog post
 * with title, excerpt, author, and date information.
 */
import { Link } from 'react-router-dom';
import type { BlogPostMetadata } from '../types/blog';

interface BlogPostCardProps {
  post: BlogPostMetadata;
}

/**
 * Creates a readable excerpt from the post title
 * For now, we'll use the title as the excerpt since we don't have body content in metadata
 */
function createExcerpt(title: string, maxLength: number = 120): string {
  if (title.length <= maxLength) {
    return title;
  }
  return title.substring(0, maxLength).trim() + '...';
}

/**
 * Formats a date string to a readable format
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  } catch {
    return 'Unknown date';
  }
}

const BlogPostCard = ({ post }: BlogPostCardProps): JSX.Element => {
  const excerpt = createExcerpt(post.title);
  const formattedDate = formatDate(post.createdAt);

  return (
    <article className="blog-card">
      <Link to={`/blog/${post.number}`} className="blog-card__link">
        <div className="blog-card__content">
          <h3 className="blog-card__title">{post.title}</h3>
          <p className="blog-card__excerpt">{excerpt}</p>
          
          <div className="blog-card__meta">
            <div className="blog-card__author">
              <img 
                src={post.author.avatarUrl} 
                alt={`${post.author.login} avatar`}
                className="blog-card__avatar"
                loading="lazy"
              />
              <span className="blog-card__author-name">{post.author.login}</span>
            </div>
            <time className="blog-card__date" dateTime={post.createdAt}>
              {formattedDate}
            </time>
          </div>
        </div>
      </Link>
    </article>
  );
};

export default BlogPostCard;
