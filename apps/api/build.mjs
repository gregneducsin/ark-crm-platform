import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.mjs",
  sourcemap: true,
  // Native/binary modules and anything with dynamic requires must stay
  // external — esbuild can't bundle argon2's native binding. pino/pino-http/
  // pino-pretty must also stay external: pino-pretty's transport spawns a
  // worker thread by resolving a file path relative to pino's own on-disk
  // location (node_modules/pino/lib/worker.js) at runtime — bundling that
  // code in breaks the path resolution regardless of any __dirname shim,
  // since the file esbuild would resolve against no longer exists on disk
  // at that relative location.
  external: ["argon2", "pg-native", "pino", "pino-http", "pino-pretty"],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
