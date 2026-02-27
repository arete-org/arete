/**
 * TypeScript interfaces for blog post data structures.
 * These interfaces match the JSON structure written by the webhook endpoint in server.js.
 */

import type {
    BlogAuthor as ContractBlogAuthor,
    BlogPost as ContractBlogPost,
    BlogPostMetadata as ContractBlogPostMetadata,
} from '@arete/contracts/web';

export type BlogAuthor = ContractBlogAuthor;
export type BlogPostMetadata = ContractBlogPostMetadata;
export type BlogPost = ContractBlogPost;

/**
 * Blog index containing array of post metadata
 */
export interface BlogIndex {
    /** Array of blog post metadata, sorted by number descending (newest first) */
    posts: BlogPostMetadata[];
}
