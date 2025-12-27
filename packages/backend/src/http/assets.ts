/**
 * @description: Resolves static assets and MIME types for the web frontend.
 * @arete-scope: interface
 * @arete-module: AssetResolver
 * @arete-risk: low - Asset resolution failures affect UI delivery.
 * @arete-ethics: low - Static asset handling has minimal ethics impact.
 */
import path from 'node:path';
import fs from 'node:fs/promises';

// --- MIME lookup table ---
const MIME_MAP = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

// --- Asset resolution helpers ---
type ResolvedAsset = {
  content: Buffer;
  absolutePath: string;
};

const tryReadFile = async (filePath: string): Promise<Buffer | undefined> => {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      throw err;
    }
    return undefined;
  }
};

const sanitizePath = (rawPath: string): string => {
  // Normalize and constrain paths to avoid traversal.
  // Strip query parameters before normalization.
  const decoded = decodeURIComponent(rawPath.split('?')[0] || '/');
  const normalized = path.normalize(decoded);

  // Block traversal outside the dist folder.
  if (normalized.startsWith('..')) {
    return '';
  }

  return normalized.replace(/^\/+/, '');
};

// --- Resolver factory ---
const createAssetResolver = (distDir: string) => {
  if (!distDir) {
    throw new Error('DIST_DIR is required for asset resolution.');
  }

  const resolveAsset = async (requestPath: string): Promise<ResolvedAsset | undefined> => {
    // Convert URL path into a dist-relative file path.
    const sanitized = sanitizePath(requestPath);
    const targetPath = sanitized.length === 0 ? 'index.html' : sanitized;

    // Resolve the request to a concrete path.
    const absolutePath = path.join(distDir, targetPath);
    const stats = await fs
      .stat(absolutePath)
      .catch(() => undefined);

    // Serve nested index for folder requests (e.g., /docs/ -> /docs/index.html).
    if (stats && stats.isDirectory()) {
      const nestedIndex = path.join(absolutePath, 'index.html');
      const nestedContent = await tryReadFile(nestedIndex);
      if (nestedContent) {
        return { content: nestedContent, absolutePath: nestedIndex };
      }
    }

    const directContent = await tryReadFile(absolutePath);
    if (directContent) {
      return { content: directContent, absolutePath };
    }

    // SPA fallback for client-side routes.
    const fallbackPath = path.join(distDir, 'index.html');
    const fallbackContent = await tryReadFile(fallbackPath);
    if (fallbackContent) {
      return { content: fallbackContent, absolutePath: fallbackPath };
    }

    return undefined;
  };

  return { resolveAsset, mimeMap: MIME_MAP };
};

export { MIME_MAP, createAssetResolver };

