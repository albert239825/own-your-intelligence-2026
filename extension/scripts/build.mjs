// Build: esbuild bundles each entry point, static assets copied to dist/.
// Chosen over @crxjs/vite-plugin to keep the toolchain minimal on node 20.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  target: "chrome116",
  sourcemap: false,
  logLevel: "info",
};

// Content scripts and HTML pages: classic scripts (iife).
await build({
  ...shared,
  format: "iife",
  entryPoints: [
    join(root, "src/content/index.ts"),
    join(root, "src/options/options.ts"),
    join(root, "src/popup/popup.ts"),
  ],
  outdir: dist,
  outExtension: { ".js": ".js" },
  entryNames: "[dir]/[name]",
});

// Flatten output dirs: esbuild keeps src-relative structure.
await build({
  ...shared,
  format: "esm",
  entryPoints: [join(root, "src/background/index.ts")],
  outfile: join(dist, "background.js"),
});

await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
await cp(join(root, "src/options/options.html"), join(dist, "options.html"));
await cp(join(root, "src/popup/popup.html"), join(dist, "popup.html"));
await cp(join(root, "fixtures"), join(dist, "fixtures"), { recursive: true });

console.log("dist/ ready");
