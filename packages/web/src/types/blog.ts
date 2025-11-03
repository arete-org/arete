/**
 * TypeScript interfaces for blog post data structures.
 * These interfaces match the JSON structure written by the webhook endpoint in server.js.
 */

/**
 * Author information for blog posts
 */
export interface BlogAuthor {
  /** GitHub username */
  login: string;
  /** URL to author's avatar image */
  avatarUrl: string;
  /** URL to author's GitHub profile */
  profileUrl: string;
}

/**
 * Metadata for blog posts (used in index)
 */
export interface BlogPostMetadata {
  /** Discussion number used as identifier/slug for routing */
  number: number;
  /** Post title */
  title: string;
  /** Author information */
  author: BlogAuthor;
  /** ISO timestamp when post was created */
  createdAt: string;
  /** ISO timestamp when post was last updated */
  updatedAt: string;
}

/**
 * Full blog post data structure
 */
export interface BlogPost extends BlogPostMetadata {
  /** Full post content (markdown) */
  body: string;
  /** URL to the GitHub discussion */
  discussionUrl: string;
  /** Number of comments on the discussion */
  commentCount: number;
}

/**
 * Blog index containing array of post metadata
 */
export interface BlogIndex {
  /** Array of blog post metadata, sorted by number descending (newest first) */
  posts: BlogPostMetadata[];
}
