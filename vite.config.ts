import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const mobileHost = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Tauri expects a fixed port; fail if it can't be used.
  server: {
    host: mobileHost || false,
    port: 1420,
    strictPort: true,
    hmr: mobileHost
      ? {
          protocol: "ws",
          host: mobileHost,
          port: 1421,
        }
      : undefined,

    /**
     * Dev-only proxies so the browser build can talk to qBittorrent and
     * Prowlarr without CORS pain. The Tauri build bypasses CORS natively
     * via @tauri-apps/plugin-http, so these are only used with `npm run dev`
     * in a plain browser.
     */
    proxy: {
      "/proxy/qbt": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/proxy\/qbt/, ""),
      },
      "/proxy/prowlarr": {
        target: "http://localhost:9696",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/proxy\/prowlarr/, ""),
      },
    },
  },

  // Don't obscure Rust panics in dev
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
