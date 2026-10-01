import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH wird im GitHub-Pages-Workflow gesetzt (z. B. "/Lerntool/").
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  define: {
    // Build-Zeitpunkt, in den Einstellungen sichtbar (zeigt, ob das Update angekommen ist)
    __BUILD_TIME__: JSON.stringify(process.env.BUILD_TIME ?? new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Lerntool",
        short_name: "Lerntool",
        description: "KI-gestütztes Lernen aus Vorlesungsfolien und Altklausuren",
        lang: "de",
        display: "standalone",
        orientation: "any",
        background_color: "#f6f7f9",
        theme_color: "#2b5cd6",
        start_url: base,
        scope: base,
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["fake-indexeddb/auto"],
  },
});
