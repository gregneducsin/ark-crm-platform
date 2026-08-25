import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sequential — each test file that touches the DB manages its own
    // isolated schema; keep runs simple and predictable for now.
    fileParallelism: false,
    // tsc --build (composite project references) emits compiled test files
    // into dist/ too — exclude them so vitest doesn't run each test twice
    // (once from src, once from the compiled dist copy).
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
