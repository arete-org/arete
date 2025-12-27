/**
 * @description: Provides structured request logging for backend endpoints.
 * @arete-scope: utility
 * @arete-module: RequestLogger
 * @arete-risk: low - Logging failures reduce observability but do not block requests.
 * @arete-ethics: moderate - Logs must avoid leaking sensitive user data.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../shared/logger';

/**
 * Builds a short log entry for monitoring within Fly.io logs.
 */
function logRequest(req: IncomingMessage, res: ServerResponse, extra = ''): void {
  // --- Timestamp ---
  const timestamp = new Date().toISOString();

  // --- URL sanitization ---
  // Avoid logging full reflect query strings (can include user content).
  let logUrl = req.url;
  if (req.url && req.url.includes('/api/reflect')) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      logUrl = parsedUrl.pathname;
    } catch {
      logUrl = req.url;
    }
  }

  // --- Emit ---
  // Keep format consistent for ingestion into log tooling.
  logger.info(`[${timestamp}] ${req.method} ${logUrl} -> ${res.statusCode} ${extra}`.trim());
}

export { logRequest };


