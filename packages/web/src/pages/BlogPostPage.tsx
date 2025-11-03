/**
 * BlogPostPage component displays individual blog posts with markdown rendering.
 * Uses discussion number as URL parameter to fetch and display the full post content.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchBlogPost } from '../utils/blog';
import BlogProvenance from '../components/BlogProvenance';
import Header from '../components/Header';
import type { BlogPost } from '../types/blog';

type LoadingState = 'loading' | 'success' | 'error' | 'not-found';

/**
 * Custom components for markdown rendering to match site styling
 */
const markdownComponents = {
  // Headings
  h1: ({ children, ...props }: any) => (
    <h1 className="blog-markdown__h1" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }: any) => (
    <h2 className="blog-markdown__h2" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }: any) => (
    <h3 className="blog-markdown__h3" {...props}>{children}</h3>
  ),
  h4: ({ children, ...props }: any) => (
    <h4 className="blog-markdown__h4" {...props}>{children}</h4>
  ),
  h5: ({ children, ...props }: any) => (
    <h5 className="blog-markdown__h5" {...props}>{children}</h5>
  ),
  h6: ({ children, ...props }: any) => (
    <h6 className="blog-markdown__h6" {...props}>{children}</h6>
  ),
  
  // Paragraphs
  p: ({ children, ...props }: any) => (
    <p className="blog-markdown__p" {...props}>{children}</p>
  ),
  
  // Links
  a: ({ href, children, ...props }: any) => (
    <a 
      href={href} 
      className="blog-markdown__link"
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      {...props}
    >
      {children}
    </a>
  ),
  
  // Code blocks
  code: ({ children, className, ...props }: any) => {
    const isInline = !className;
    if (isInline) {
      return <code className="blog-markdown__code-inline" {...props}>{children}</code>;
    }
    return <code className="blog-markdown__code-block" {...props}>{children}</code>;
  },
  
  pre: ({ children, ...props }: any) => (
    <pre className="blog-markdown__pre" {...props}>{children}</pre>
  ),
  
  // Blockquotes
  blockquote: ({ children, ...props }: any) => (
    <blockquote className="blog-markdown__blockquote" {...props}>{children}</blockquote>
  ),
  
  // Lists
  ul: ({ children, ...props }: any) => (
    <ul className="blog-markdown__ul" {...props}>{children}</ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol className="blog-markdown__ol" {...props}>{children}</ol>
  ),
  li: ({ children, ...props }: any) => (
    <li className="blog-markdown__li" {...props}>{children}</li>
  ),
  
  // Tables (from remark-gfm)
  table: ({ children, ...props }: any) => (
    <div className="blog-markdown__table-wrapper">
      <table className="blog-markdown__table" {...props}>{children}</table>
    </div>
  ),
  thead: ({ children, ...props }: any) => (
    <thead className="blog-markdown__thead" {...props}>{children}</thead>
  ),
  tbody: ({ children, ...props }: any) => (
    <tbody className="blog-markdown__tbody" {...props}>{children}</tbody>
  ),
  tr: ({ children, ...props }: any) => (
    <tr className="blog-markdown__tr" {...props}>{children}</tr>
  ),
  th: ({ children, ...props }: any) => (
    <th className="blog-markdown__th" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: any) => (
    <td className="blog-markdown__td" {...props}>{children}</td>
  ),
  
  // Horizontal rule
  hr: ({ ...props }: any) => (
    <hr className="blog-markdown__hr" {...props} />
  ),
  
  // Images
  img: ({ src, alt, ...props }: any) => (
    <img 
      src={src} 
      alt={alt} 
      className="blog-markdown__img"
      loading="lazy"
      {...props}
    />
  ),
};

const BlogPostPage = (): JSX.Element => {
  const { number } = useParams<{ number: string }>();
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [post, setPost] = useState<BlogPost | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Breadcrumb items for blog post page
  const breadcrumbItems = [
    { label: 'Blog', path: '/blog' },
    { label: post ? post.title : `Post #${number}` }
  ];

  useEffect(() => {
    if (!number) {
      setLoadingState('error');
      setErrorMessage('Blog post number is missing from URL.');
      return;
    }

    const discussionNumber = parseInt(number, 10);
    if (isNaN(discussionNumber)) {
      setLoadingState('error');
      setErrorMessage('Invalid blog post number.');
      return;
    }

    let isMounted = true;

    const loadPost = async () => {
      setLoadingState('loading');
      setErrorMessage('');
      setPost(null);

      try {
        const fetchedPost = await fetchBlogPost(discussionNumber);

        if (!isMounted) {
          return;
        }

        if (!fetchedPost) {
          setLoadingState('not-found');
          return;
        }

        setPost(fetchedPost);
        setLoadingState('success');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : 'Failed to load blog post.');
        setLoadingState('error');
      }
    };

    void loadPost();

    return () => {
      isMounted = false;
    };
  }, [number]);

  if (loadingState === 'loading') {
    return (
      <section className="site-section">
        <Header breadcrumbItems={breadcrumbItems} />
        
        <div className="interaction-status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Loading blog post...</p>
        </div>
      </section>
    );
  }

  if (loadingState === 'not-found') {
    return (
      <section className="site-section">
        <Header breadcrumbItems={breadcrumbItems} />
        
        <article className="card">
          <h2>Post Not Found</h2>
          <p>
            We couldn&apos;t find a blog post with discussion number <code>{number}</code>.
          </p>
          <Link to="/blog" className="cta-button primary">
            Back to blog
          </Link>
        </article>
      </section>
    );
  }

  if (loadingState === 'error') {
    return (
      <section className="site-section">
        <Header breadcrumbItems={breadcrumbItems} />
        
        <article className="card">
          <h2>Unable to Load Blog Post</h2>
          <p>{errorMessage}</p>
          <button 
            onClick={() => window.location.reload()}
            className="cta-button primary"
            type="button"
          >
            Try Again
          </button>
        </article>
      </section>
    );
  }

  if (!post) {
    return (
      <section className="site-section">
        <Header breadcrumbItems={breadcrumbItems} />
        
        <article className="card">
          <h2>No Post Data</h2>
          <p>Blog post data is unavailable.</p>
        </article>
      </section>
    );
  }

  return (
    <section className="site-section">
      <Header breadcrumbItems={breadcrumbItems} />

      <article className="blog-post">
        <header className="blog-post__header">
          <h1 className="blog-post__title">{post.title}</h1>
        </header>

        <div className="blog-post__content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {post.body}
          </ReactMarkdown>
        </div>

        <BlogProvenance post={post} />
      </article>
    </section>
  );
};

export default BlogPostPage;
