/**
 * @description: Serves runtime configuration for the web app.
 * @arete-scope: interface
 * @arete-module: RuntimeConfigHandler
 * @arete-risk: low - Misconfiguration affects UX but not core data integrity.
 * @arete-ethics: moderate - Incorrect exposure of config could mislead users.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type LogRequest = (req: IncomingMessage, res: ServerResponse, extra?: string) => void;

// --- Handler factory ---
const createRuntimeConfigHandler = ({ logRequest }: { logRequest: LogRequest }) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // --- Method validation ---
      // Only GET is supported for config reads.
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        logRequest(req, res, 'config method-not-allowed');
        return;
      }

      // --- Turnstile exposure rules ---
      const hasTurnstileKeys = Boolean(
        process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY
      );
      // Avoid exposing secrets; only surface the site key when both are configured.
      const payload = {
        turnstileSiteKey: hasTurnstileKeys ? process.env.TURNSTILE_SITE_KEY : ''
      };

      // --- Response ---
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(payload));
      logRequest(req, res, 'config ok');
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Internal server error' }));
      logRequest(req, res, `config error ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

export { createRuntimeConfigHandler };


