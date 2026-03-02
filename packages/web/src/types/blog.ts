/**
 * @description: Defines web-facing blog types derived from the shared contracts package.
 * @footnote-scope: interface
 * @footnote-module: WebBlogTypes
 * @footnote-risk: low - Type drift can break blog rendering assumptions across the UI.
 * @footnote-ethics: low - These types document public content structures without handling user data.
 */

/**
 * TypeScript interfaces for blog post data structures.
 * These interfaces match the JSON structure written by the webhook endpoint in server.js.
 */

import type {
    BlogAuthor as ContractBlogAuthor,
    BlogPost as ContractBlogPost,
    BlogPostMetadata as ContractBlogPostMetadata,
} from '@footnote/contracts/web';

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
