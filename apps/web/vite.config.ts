import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Sane defaults instead of throwing on a fresh clone — the old app's vite
// config required PORT/BASE_PATH with no fallback, which crashed immediately
// for a new developer who hadn't read the .env.example carefully.
const port = Number(process.env.WEB_PORT ?? "5173");
const basePath = process.env.BASE_PATH ?? "/";
const apiProxyPort = process.env.API_PROXY_PORT ?? "3001";

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: `http://localhost:${apiProxyPort}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // tsc --build (composite project references) emits compiled test files
    // into dist/ too — exclude them so vitest doesn't run each test twice.
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
