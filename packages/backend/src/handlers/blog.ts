/**
 * @description: Handles blog index and post read endpoints.
 * @arete-scope: interface
 * @arete-module: BlogHandlers
 * @arete-risk: moderate - Blog retrieval failures degrade content availability.
 * @arete-ethics: low - Public content delivery has minimal ethics impact.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type BlogStore = {
  readBlogIndex: () => Promise<unknown[]>;
  readBlogPost: (postId: string) => Promise<unknown | undefined>;
};

type LogRequest = (req: IncomingMessage, res: ServerResponse, extra?: string) => void;

// --- Handler factory ---
const createBlogHandlers = ({ blogStore, logRequest }: { blogStore: BlogStore; logRequest: LogRequest }) => {
  const handleBlogIndexRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // --- Method validation ---
      // Only allow reads for the public blog index.
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        logRequest(req, res, 'blog index method-not-allowed');
        return;
      }

      // --- Fetch and respond ---
      const indexArray = await blogStore.readBlogIndex();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(indexArray));
      logRequest(req, res, `blog index count=${indexArray.length}`);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Internal server error' }));
      logRequest(req, res, `blog index error ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const handleBlogPostRequest = async (req: IncomingMessage, res: ServerResponse, postId: string): Promise<void> => {
    try {
      // --- Method validation ---
      // Only allow reads for individual posts.
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        logRequest(req, res, 'blog post method-not-allowed');
        return;
      }

      // --- Input validation ---
      // Reject non-numeric identifiers to prevent path probing.
      if (!/^\d+$/.test(postId)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid post id' }));
        logRequest(req, res, 'blog post invalid-id');
        return;
      }

      // --- Fetch and respond ---
      const post = await blogStore.readBlogPost(postId);
      if (!post) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Post not found' }));
        logRequest(req, res, `blog post missing id=${postId}`);
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(post));
      logRequest(req, res, `blog post id=${postId}`);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Internal server error' }));
      logRequest(req, res, `blog post error ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  return { handleBlogIndexRequest, handleBlogPostRequest };
};

export { createBlogHandlers };


