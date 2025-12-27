/**
 * BlogProvenance component displays author information, timestamps,
 * GitHub discussion link, and comment count for blog posts.
 * Follows the same patterns as ProvenanceFooter for consistency.
 */
import type { CSSProperties } from 'react';
import type { BlogPost } from '../types/blog';

interface BlogProvenanceProps {
  post: BlogPost;
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
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'Unknown date';
  }
}

/**
 * Formats relative time (e.g., "2 days ago")
 */
function formatRelativeTime(dateString: string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffInSeconds < 60) {
      return 'Just now';
    } else if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 86400) {
      const hours = Math.floor(diffInSeconds / 3600);
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 2592000) {
      const days = Math.floor(diffInSeconds / 86400);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    } else {
      return formatDate(dateString);
    }
  } catch {
    return 'Unknown time';
  }
}

const BlogProvenance = ({ post }: BlogProvenanceProps): JSX.Element => {
  const createdDate = formatDate(post.createdAt);
  const updatedDate = formatDate(post.updatedAt);
  const relativeCreated = formatRelativeTime(post.createdAt);
  const relativeUpdated = formatRelativeTime(post.updatedAt);
  const isUpdated = post.createdAt !== post.updatedAt;
  const riskStyle = { '--risk-color': '#7FDCA4' } as CSSProperties;

  return (
    <aside 
      className="provenance-footer"
      role="complementary"
      aria-label="Blog post provenance and metadata"
      style={riskStyle} // Use sage green for blog posts
    >
      <div className="provenance-header">
        Blog Post - Discussion #{post.number}
      </div>
      
      <div className="provenance-main">
        <div className="blog-provenance__author">
          <img 
            src={post.author.avatarUrl} 
            alt={`${post.author.login} avatar`}
            className="blog-provenance__avatar"
            loading="lazy"
          />
          <span className="blog-provenance__author-name">{post.author.login}</span>
        </div>
        
        <span className="provenance-separator"> • </span>
        
        <time className="blog-provenance__date" dateTime={post.createdAt} title={createdDate}>
          {relativeCreated}
        </time>
        
        {isUpdated && (
          <>
            <span className="provenance-separator"> • </span>
            <time className="blog-provenance__updated" dateTime={post.updatedAt} title={updatedDate}>
              Updated {relativeUpdated}
            </time>
          </>
        )}
        
        {post.commentCount > 0 && (
          <>
            <span className="provenance-separator"> • </span>
            <span className="blog-provenance__comments">
              {post.commentCount} comment{post.commentCount !== 1 ? 's' : ''}
            </span>
          </>
        )}
      </div>

      <div className="provenance-meta">
        <span className="blog-provenance__discussion-id">Discussion #{post.number}</span>
        <span className="provenance-separator"> • </span>
        <span className="blog-provenance__created-full">{createdDate}</span>
        {isUpdated && (
          <>
            <span className="provenance-separator"> • </span>
            <span className="blog-provenance__updated-full">Updated: {updatedDate}</span>
          </>
        )}
        
        <a 
          href={post.discussionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="provenance-link"
          aria-label="View discussion on GitHub"
        >
          💬 View Discussion
        </a>
      </div>
    </aside>
  );
};

export default BlogProvenance;
