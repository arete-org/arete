import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite configuration keeps things lean while allowing TypeScript paths for components and styles.
export default defineConfig({
  plugins: [react()],
  define: {
    // In production, require real Turnstile keys. Only use test keys as fallback in development.
    // WARNING: If VITE_TURNSTILE_SITE_KEY is not set in production, CAPTCHA will not work!
    'import.meta.env.VITE_TURNSTILE_SITE_KEY': JSON.stringify(
      process.env.VITE_TURNSTILE_SITE_KEY || 
      (process.env.NODE_ENV === 'production' ? '' : '1x00000000000000000000BB') // Test key fallback for development only
    ),
    'import.meta.env.VITE_SKIP_CAPTCHA': JSON.stringify(process.env.VITE_SKIP_CAPTCHA || 'false'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
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
      '@ethics-core': fileURLToPath(new URL('../ethics-core/src', import.meta.url)),
      'ethics-core': fileURLToPath(new URL('../ethics-core/src/index.ts', import.meta.url)),
      '@styles': fileURLToPath(new URL('./src/styles', import.meta.url)),
      '@theme': fileURLToPath(new URL('./src/theme', import.meta.url)),
    },
  },
});
