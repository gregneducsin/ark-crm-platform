import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc --build (composite project references) emits compiled test files
    // into dist/ too — exclude them so vitest doesn't run each test twice.
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
