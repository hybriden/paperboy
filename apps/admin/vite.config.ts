import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_URL = process.env.VITE_API_URL ?? "http://localhost:8091";

export default defineConfig({
  plugins: [react()],
  // No inline module-preload polyfill: it emits an inline <script> that the
  // admin's strict `script-src 'self'` CSP (nginx.conf) would block. The admin
  // targets modern browsers with native modulepreload, so the polyfill is dead
  // weight anyway.
  build: { modulePreload: { polyfill: false } },
  server: {
    port: 8090,
    host: true,
    proxy: {
      "/api": { target: API_URL, changeOrigin: true },
    },
  },
  preview: { port: 8090, host: true },
});
