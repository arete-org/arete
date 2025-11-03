/**
 * BlogListPage component displays a list of blog posts with infinite scroll functionality.
 * Uses Intersection Observer API to load more posts as the user scrolls.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import BlogPostCard from '../components/BlogPostCard';
import Header from '../components/Header';
import { fetchBlogIndex, getLatestBlogPosts, getBlogPostsPage } from '../utils/blog';
import type { BlogPostMetadata } from '../types/blog';

type LoadingState = 'loading' | 'success' | 'error' | 'loading-more';

const BlogListPage = (): JSX.Element => {
  const [posts, setPosts] = useState<BlogPostMetadata[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [hasMorePosts, setHasMorePosts] = useState<boolean>(true);
  const [currentPage, setCurrentPage] = useState<number>(1);
  
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  
  const POSTS_PER_PAGE = 6;

  // Breadcrumb items for blog list page
  const breadcrumbItems = [
    { label: 'Blog' }
  ];

  /**
   * Loads the initial blog posts
   */
  const loadInitialPosts = useCallback(async () => {
    try {
      setLoadingState('loading');
      setErrorMessage('');
      
      const initialPosts = await getLatestBlogPosts(POSTS_PER_PAGE);
      
      if (initialPosts.length === 0) {
        setLoadingState('success');
        setHasMorePosts(false);
        return;
      }
      
      setPosts(initialPosts);
      setCurrentPage(1);
      setHasMorePosts(initialPosts.length === POSTS_PER_PAGE);
      setLoadingState('success');
    } catch (error) {
      console.error('Error loading initial blog posts:', error);
      setErrorMessage('Failed to load blog posts. Please try again later.');
      setLoadingState('error');
    }
  }, []);

  /**
   * Loads more posts for infinite scroll
   */
  const loadMorePosts = useCallback(async () => {
    if (loadingState === 'loading-more' || !hasMorePosts) {
      return;
    }

    try {
      setLoadingState('loading-more');
      
      const nextPage = currentPage + 1;
      
      // Fetch only the posts for the next page
      const newPosts = await getBlogPostsPage(nextPage, POSTS_PER_PAGE);
      
      if (newPosts.length === 0) {
        setHasMorePosts(false);
        setLoadingState('success');
        return;
      }
      
      setPosts(prevPosts => [...prevPosts, ...newPosts]);
      setCurrentPage(nextPage);
      setHasMorePosts(newPosts.length === POSTS_PER_PAGE);
      setLoadingState('success');
    } catch (error) {
      console.error('Error loading more blog posts:', error);
      setErrorMessage('Failed to load more posts. Please try again.');
      setLoadingState('error');
    }
  }, [currentPage, hasMorePosts, loadingState]);

  /**
   * Sets up the Intersection Observer for infinite scroll
   */
  useEffect(() => {
    if (!loadMoreRef.current || !hasMorePosts) {
      return;
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && loadingState !== 'loading-more') {
          loadMorePosts();
        }
      },
      {
        root: null,
        rootMargin: '100px',
        threshold: 0.1
      }
    );

    observerRef.current.observe(loadMoreRef.current);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [loadMorePosts, hasMorePosts, loadingState]);

  /**
   * Load initial posts on component mount
   */
  useEffect(() => {
    loadInitialPosts();
  }, [loadInitialPosts]);

  /**
   * Retry loading posts
   */
  const handleRetry = () => {
    loadInitialPosts();
  };

  if (loadingState === 'loading') {
    return (
      <section className="site-section">
        <Header breadcrumbItems={breadcrumbItems} />
        
        <div className="interaction-status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Loading blog posts...</p>
        </div>
      </section>
    );
  }

  if (loadingState === 'error') {
    return (
      <section className="site-section">
        <Header breadcrumbItems={breadcrumbItems} />
        
        <article className="card">
          <h2>Unable to Load Blog Posts</h2>
          <p>{errorMessage}</p>
          <button 
            onClick={handleRetry}
            className="cta-button primary"
            type="button"
          >
            Try Again
          </button>
        </article>
      </section>
    );
  }

  return (
    <section className="site-section">
      <Header breadcrumbItems={breadcrumbItems} />

      {posts.length === 0 ? (
        <article className="card">
          <h2>No Blog Posts Yet</h2>
          <p>Check back soon for new posts from the ARETE community.</p>
          <Link to="/" className="cta-button primary">
            Back to home
          </Link>
        </article>
      ) : (
        <>
          <div className="blog-grid">
            {posts.map((post) => (
              <BlogPostCard key={post.number} post={post} />
            ))}
          </div>
          
          {/* Loading more indicator */}
          {hasMorePosts && (
            <div ref={loadMoreRef} className="blog-load-more">
              {loadingState === 'loading-more' ? (
                <div className="interaction-status" aria-live="polite">
                  <div className="spinner" aria-hidden="true" />
                  <p>Loading more posts...</p>
                </div>
              ) : (
                <div className="blog-load-more__trigger">
                  <p>Scroll down to load more posts</p>
                </div>
              )}
            </div>
          )}
          
          {!hasMorePosts && posts.length > 0 && (
            <div className="blog-end">
              <p>The end... Or is it?</p>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default BlogListPage;
