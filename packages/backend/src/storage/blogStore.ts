/**
 * @description: Reads and writes blog post JSON payloads to backend-owned storage.
 * @arete-scope: utility
 * @arete-module: BlogStore
 * @arete-risk: moderate - Storage failures can break blog sync or serve stale data.
 * @arete-ethics: low - Blog content is public, but integrity still matters.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../shared/logger';

type BlogPostAuthor = {
  login: string;
  avatarUrl: string;
  profileUrl: string;
};

type BlogPostIndexEntry = {
  number: number;
  title: string;
  author: BlogPostAuthor;
  createdAt: string;
  updatedAt: string;
};

type BlogPost = BlogPostIndexEntry & {
  body: string;
  discussionUrl: string;
  commentCount: number;
};

// --- GitHub payload typing ---
export type GitHubDiscussion = {
  number: number;
  title: string;
  body: string;
  user: {
    login: string;
    avatar_url: string;
    html_url: string;
  };
  created_at: string;
  updated_at: string;
  html_url: string;
  comments?: number;
};

// --- Store factory ---
const createBlogStore = (blogPostsDir: string) => {
  if (!blogPostsDir) {
    throw new Error('BLOG_POSTS_DIR is required for blog storage.');
  }

  const writeBlogPost = async (discussion: GitHubDiscussion): Promise<void> => {
    try {
      // --- Storage prep ---
      // Ensure the storage directory exists before writing.
      await fs.mkdir(blogPostsDir, { recursive: true });

      // --- Payload normalization ---
      // Normalize the GitHub payload into the format we serve over the API.
      const postObject: BlogPost = {
        number: discussion.number,
        title: discussion.title,
        body: discussion.body,
        author: {
          login: discussion.user.login,
          avatarUrl: discussion.user.avatar_url,
          profileUrl: discussion.user.html_url
        },
        createdAt: discussion.created_at,
        updatedAt: discussion.updated_at,
        discussionUrl: discussion.html_url,
        commentCount: discussion.comments || 0
      };

      // --- Persist post payload ---
      const postFilePath = path.join(blogPostsDir, `${discussion.number}.json`);
      await fs.writeFile(postFilePath, JSON.stringify(postObject, null, 2));

      // --- Refresh index ---
      // Update the index file with a lightweight list of posts.
      const indexFilePath = path.join(blogPostsDir, 'index.json');
      let indexArray: BlogPostIndexEntry[] = [];
      try {
        const indexContent = await fs.readFile(indexFilePath, 'utf8');
        indexArray = JSON.parse(indexContent) as BlogPostIndexEntry[];
      } catch {
        indexArray = [];
      }

      // --- Index normalization ---
      // De-duplicate existing entries before inserting the latest one.
      indexArray = indexArray.filter(post => post.number !== discussion.number);

      indexArray.push({
        number: discussion.number,
        title: discussion.title,
        author: {
          login: discussion.user.login,
          avatarUrl: discussion.user.avatar_url,
          profileUrl: discussion.user.html_url
        },
        createdAt: discussion.created_at,
        updatedAt: discussion.updated_at
      });

      indexArray.sort((a, b) => b.number - a.number);

      await fs.writeFile(indexFilePath, JSON.stringify(indexArray, null, 2));
    } catch (error) {
      logger.error(`Error writing blog post: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };

  const readBlogIndex = async (): Promise<BlogPostIndexEntry[]> => {
    try {
      // --- Index read ---
      // Missing index is treated as empty content.
      const indexContent = await fs.readFile(path.join(blogPostsDir, 'index.json'), 'utf8');
      const parsed = JSON.parse(indexContent);
      return Array.isArray(parsed) ? (parsed as BlogPostIndexEntry[]) : [];
    } catch {
      return [];
    }
  };

  const readBlogPost = async (postNumber: string): Promise<BlogPost | undefined> => {
    try {
      // --- Post read ---
      // Single post files are addressed by discussion number.
      const postContent = await fs.readFile(
        path.join(blogPostsDir, `${postNumber}.json`),
        'utf8'
      );
      return JSON.parse(postContent) as BlogPost;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        throw err;
      }
      return undefined;
    }
  };

  return {
    writeBlogPost,
    readBlogIndex,
    readBlogPost
  };
};

export { createBlogStore };


