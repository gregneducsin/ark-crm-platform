import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    // tsc --build (composite project references) emits compiled test files
    // into dist/ too — exclude them so vitest doesn't run each test twice.
    exclude: ["**/node_modules/**", "dist/**"],
    globalSetup: ["./src/test/globalSetup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    env: {
      // Never actually bound to a port — supertest wraps the Express app
      // directly — but env.ts requires it to be set regardless.
      PORT: "3001",
      CORS_ALLOWED_ORIGINS: "http://localhost:5173",
      LOG_LEVEL: "silent",
    },
  },
});
