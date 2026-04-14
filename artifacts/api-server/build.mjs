/**
 * Production build script for api-server.
 * Bundles src/index.ts → dist/index.mjs using esbuild.
 * Uses esbuild-plugin-pino to correctly bundle Pino's worker threads.
 */

import { build } from "esbuild";
import { createRequire } from "module";
import { rmSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// esbuild-plugin-pino is incompatible with esbuild >=0.26; keep pino external instead
const pinoPlugin = null;

const outdir = path.join(__dirname, "dist");

// Clean previous build
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

console.log("Building api-server...");

await build({
  entryPoints: [path.join(__dirname, "src", "index.ts")],
  outfile: path.join(outdir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // Banner polyfills __dirname / __filename for ESM
  banner: {
    js: [
      `import { createRequire as _cr } from "module";`,
      `import { fileURLToPath as _fup } from "url";`,
      `import { dirname as _dn } from "path";`,
      `const require = _cr(import.meta.url);`,
      `const __filename = _fup(import.meta.url);`,
      `const __dirname = _dn(__filename);`,
    ].join("\n"),
  },
  // Keep native Node built-ins external
  external: [
    "fsevents",
    // TypeScript compiler API — loaded on demand by code-context.ts
    "typescript",
    // Pino kept external to avoid bundling worker thread internals
    "pino",
    "pino-http",
    "pino-pretty",
  ],
  plugins: pinoPlugin ? [pinoPlugin({ transports: ["pino-pretty"] })] : [],
  metafile: false,
  logLevel: "info",
});

console.log("Build complete → dist/index.mjs");
