/**
 * @description: Handles GitHub webhook ingestion for blog updates.
 * @arete-scope: interface
 * @arete-module: WebhookHandler
 * @arete-risk: moderate - Malformed payloads can break sync if not guarded.
 * @arete-ethics: moderate - Accepting spoofed payloads could mislead users.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitHubDiscussion } from '../storage/blogStore';
import { logger } from '../shared/logger';

type LogRequest = (req: IncomingMessage, res: ServerResponse, extra?: string) => void;

type WebhookDeps = {
  writeBlogPost: (discussion: GitHubDiscussion) => Promise<void>;
  verifyGitHubSignature: (secret: string, body: Buffer, signature: string) => boolean;
  logRequest: LogRequest;
};

const createWebhookHandler = ({ writeBlogPost, verifyGitHubSignature, logRequest }: WebhookDeps) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const maxBodyBytes = 256 * 1024;

      // --- Method validation ---
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        logRequest(req, res, 'webhook method-not-allowed');
        return;
      }

      // --- Configuration gate ---
      if (!process.env.GITHUB_WEBHOOK_SECRET) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ message: 'Ignored: webhook not configured' }));
        logRequest(req, res, 'webhook secret-not-configured');
        return;
      }

      // --- Signature extraction ---
      const signature = req.headers['x-hub-signature-256'];
      if (!signature || Array.isArray(signature)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Missing signature' }));
        logRequest(req, res, 'webhook missing-signature');
        return;
      }

      // --- Body capture (raw bytes for signature) ---
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let bodyTooLarge = false;

      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Payload too large' }));
          logRequest(req, res, `webhook payload-too-large contentLength=${contentLength}`);
          return;
        }
      }

      req.on('data', chunk => {
        if (bodyTooLarge) {
          return;
        }

        bodyBytes += chunk.length;
        if (bodyBytes > maxBodyBytes) {
          bodyTooLarge = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Payload too large' }));
          logRequest(req, res, 'webhook payload-too-large');
          req.destroy();
          return;
        }

        chunks.push(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        req.on('end', () => resolve());
        req.on('error', reject);
      });
      if (bodyTooLarge) {
        return;
      }
      const body = Buffer.concat(chunks);

      // --- Signature verification ---
      if (!verifyGitHubSignature(process.env.GITHUB_WEBHOOK_SECRET, body, signature)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        logRequest(req, res, 'webhook invalid-signature');
        return;
      }

      // --- JSON parsing ---
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body.toString()) as Record<string, unknown>;
      } catch (error) {
        logger.warn(`Webhook received invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        logRequest(req, res, 'webhook invalid-json');
        return;
      }

      // --- Payload validation ---
      const action = typeof payload.action === 'string' ? payload.action : undefined;
      if (!action || !payload.discussion || !payload.repository) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Invalid payload structure' }));
        logRequest(req, res, 'webhook invalid-payload');
        return;
      }

      // --- Repo + category gating ---
      const repository = payload.repository as { full_name?: string };
      if (repository.full_name !== 'arete-org/arete') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ message: 'Ignored: wrong repository' }));
        logRequest(req, res, 'webhook ignored-wrong-repo');
        return;
      }

      const discussion = payload.discussion as GitHubDiscussion & {
        category?: { name?: string };
      };
      if (discussion.category?.name !== 'Blog') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ message: 'Ignored: not Blog category' }));
        logRequest(req, res, 'webhook ignored-not-blog');
        return;
      }

      // --- Action filtering ---
      if (action !== 'created' && action !== 'edited') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ message: 'Ignored: action not relevant' }));
        logRequest(req, res, 'webhook ignored-action');
        return;
      }

      // --- Write-through ---
      await writeBlogPost(discussion);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, postNumber: discussion.number }));
      logRequest(req, res, `webhook success postNumber=${discussion.number}`);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Internal server error' }));
      logRequest(req, res, `webhook error ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

export { createWebhookHandler };


