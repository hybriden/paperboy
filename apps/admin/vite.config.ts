import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_URL = process.env.VITE_API_URL ?? "http://localhost:8091";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8090,
    host: true,
    proxy: {
      "/api": { target: API_URL, changeOrigin: true },
    },
  },
  preview: { port: 8090, host: true },
});
