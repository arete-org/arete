/**
 * Utility functions for fetching blog posts and index from static JSON files.
 * Uses discussion number as identifier/slug for routing.
 */

import type { BlogPost, BlogPostMetadata, BlogIndex } from '../types/blog';

/**
 * Fetches the blog index containing metadata for all posts
 * @returns Promise resolving to blog index or null if not found
 */
export async function fetchBlogIndex(): Promise<BlogIndex | null> {
  try {
    const response = await fetch('/blog-posts/index.json');
    
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch blog index: ${response.status} ${response.statusText}`);
    }
    
    const posts: BlogPostMetadata[] = await response.json();
    return { posts };
  } catch (error) {
    console.error('Error fetching blog index:', error);
    return null;
  }
}

/**
 * Fetches a specific blog post by discussion number
 * @param discussionNumber - The discussion number used as identifier/slug
 * @returns Promise resolving to blog post or null if not found
 */
export async function fetchBlogPost(discussionNumber: number): Promise<BlogPost | null> {
  try {
    const response = await fetch(`/blog-posts/${discussionNumber}.json`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch blog post ${discussionNumber}: ${response.status} ${response.statusText}`);
    }
    
    const post: BlogPost = await response.json();
    return post;
  } catch (error) {
    console.error(`Error fetching blog post ${discussionNumber}:`, error);
    return null;
  }
}

/**
 * Fetches multiple blog posts by their discussion numbers
 * @param discussionNumbers - Array of discussion numbers to fetch
 * @returns Promise resolving to array of blog posts (null entries for failed fetches)
 */
export async function fetchBlogPosts(discussionNumbers: number[]): Promise<(BlogPost | null)[]> {
  const promises = discussionNumbers.map(number => fetchBlogPost(number));
  return Promise.all(promises);
}

/**
 * Gets the latest blog posts from the index
 * @param limit - Maximum number of posts to return (default: 10)
 * @returns Promise resolving to array of latest blog post metadata
 */
export async function getLatestBlogPosts(limit: number = 10): Promise<BlogPostMetadata[]> {
  const index = await fetchBlogIndex();
  
  if (!index) {
    return [];
  }
  
  return index.posts.slice(0, limit);
}

/**
 * Gets a specific page of blog posts for pagination
 * @param page - Page number (1-based)
 * @param pageSize - Number of posts per page (default: 6)
 * @returns Promise resolving to array of blog post metadata for the requested page
 */
export async function getBlogPostsPage(page: number, pageSize: number = 6): Promise<BlogPostMetadata[]> {
  const index = await fetchBlogIndex();
  
  if (!index) {
    return [];
  }
  
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  
  return index.posts.slice(startIndex, endIndex);
}

/**
 * Searches for blog posts by title (case-insensitive)
 * @param query - Search query
 * @returns Promise resolving to array of matching blog post metadata
 */
export async function searchBlogPosts(query: string): Promise<BlogPostMetadata[]> {
  const index = await fetchBlogIndex();
  
  if (!index || !query.trim()) {
    return [];
  }
  
  const lowercaseQuery = query.toLowerCase();
  
  return index.posts.filter(post => 
    post.title.toLowerCase().includes(lowercaseQuery)
  );
}

/**
 * Gets blog post metadata by discussion number from the index
 * @param discussionNumber - The discussion number to find
 * @returns Promise resolving to blog post metadata or null if not found
 */
export async function getBlogPostMetadata(discussionNumber: number): Promise<BlogPostMetadata | null> {
  const index = await fetchBlogIndex();
  
  if (!index) {
    return null;
  }
  
  return index.posts.find(post => post.number === discussionNumber) || null;
}
