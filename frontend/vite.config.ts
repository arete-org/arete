import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "favicon.png", "apple-touch-icon.png"],
      manifest: {
        name: "Arete — Assistant d’entraînement",
        short_name: "Arete",
        description:
          "Assistant d’entraînement intelligent, nourri par l’IA et tes données personnelles",
        theme_color: "#0A0A0F",
        background_color: "#0A0A0F",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // A hand-written worker (src/sw.ts) so it can show Web Push notifications;
      // it keeps the precache, SPA fallback and /api/ caching of the generated one.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // Install fetches the shell only (what index.html loads: the entry and the
      // vendor groups below); other hashed assets are cached on first use (sw.ts).
      injectManifest: {
        globPatterns: [
          "index.html",
          "registerSW.js",
          "assets/{index,react,query,rolldown-runtime}-*.{js,css}",
          "assets/{Inter,JetBrainsMono}-Regular-*.woff2",
        ],
      },
    }),
  ],
  build: {
    // Character portraits are fetched when shown, not inlined into the entry chunk.
    assetsInlineLimit: (file) => (file.includes("/assets/rpg/") ? false : undefined),
    rollupOptions: {
      output: {
        // Vendor code changes less often than the app: separate files stay cached across deploys.
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/ },
            { name: "query", test: /node_modules[\\/]@tanstack[\\/]/ },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        // Backend location; override when 8000 is taken: VITE_API_TARGET=http://localhost:8001 npm run dev
        target: process.env.VITE_API_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
