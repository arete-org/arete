// @ts-nocheck
import { fileURLToPath, URL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite plugin to set CSP headers for /embed route in development
type NextFunction = (err?: unknown) => void;
type DevServer = {
  middlewares: {
    use: (handler: (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void) => void;
  };
};

const cspPlugin = () => ({
  name: 'csp-headers',
  configureServer(server: DevServer) {
    server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: NextFunction) => {
      // Set CSP frame-ancestors header for /embed route
      if (req.url && (req.url === '/embed' || req.url.startsWith('/embed/'))) {
        // Allow embedding from production domains and localhost for development
        // Note: localhost is included to allow dev servers to embed even when running in production mode
        const frameAncestors = [
          'https://jordanmakes.fly.dev',
          'https://ai.jordanmakes.dev',
          'https://portfolio.jordanmakes.dev',
          'https://jordanmakes.dev',
          'https://blog.jordanmakes.dev',
          'https://www.jordanmakes.dev',
          'http://localhost:3000',
          'http://localhost:5173'
        ];
        
        // Allow additional domains via ARETE_FRAME_ANCESTORS environment variable (comma-separated)
        if (process.env.ARETE_FRAME_ANCESTORS) {
          const additionalDomains = process.env.ARETE_FRAME_ANCESTORS.split(',')
            .map(domain => domain.trim())
            .map(domain => domain.replace(/\/+$/, '')) // Remove trailing slashes
            .filter(domain => domain.length > 0);
          frameAncestors.push(...additionalDomains);
        }
        
        // Normalize all domains: remove trailing slashes and deduplicate
        const normalizedFrameAncestors = [...new Set(
          frameAncestors.map(domain => domain.replace(/\/+$/, ''))
        )];
        
        // Allow embedding from allowed domains and also allow all necessary resources
        const csp = [
          `frame-ancestors ${normalizedFrameAncestors.join(' ')}`,
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://challenges.cloudflare.com",
          "style-src 'self' 'unsafe-inline' data:",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "frame-src 'self' https://challenges.cloudflare.com",
          "connect-src 'self' https://challenges.cloudflare.com https://api.openai.com"
        ].join('; ');
        res.setHeader('Content-Security-Policy', csp);
      }
      next();
    });
  },
});

// Vite configuration keeps things lean while allowing TypeScript paths for components and styles.
export default defineConfig({
  plugins: [react(), cspPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/config.json': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/trace': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@components': fileURLToPath(new URL('./src/components', import.meta.url)),
      '@pages': fileURLToPath(new URL('./src/pages', import.meta.url)),
      '@arete/backend/ethics-core': fileURLToPath(new URL('../backend/src/ethics-core/index.ts', import.meta.url)),
      '@styles': fileURLToPath(new URL('./src/styles', import.meta.url)),
      '@theme': fileURLToPath(new URL('./src/theme', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
});
