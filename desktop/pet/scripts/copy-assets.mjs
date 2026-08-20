// Copies the plain HTML asset (pet.html) next to the compiled main bundle
// so `electron .` and the verify harness can load it from dist/ via
// loadFile, and promotes the CommonJS preload emitted by
// tsconfig.preload.json into dist/ (the preload build keeps its own
// dist-preload/ outDir so its incidental CJS copies never overwrite the
// ESM dist/ outputs). pet-view.js needs no copy: tsc emits it directly
// into dist/ (outDir: dist, include: src).
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const distDir = path.join(here, "..", "dist");
const preloadDir = path.join(here, "..", "dist-preload");

const assets = ["pet.html"];

mkdirSync(distDir, { recursive: true });
for (const name of assets) {
  copyFileSync(path.join(srcDir, name), path.join(distDir, name));
}
copyFileSync(
  path.join(preloadDir, "pet-preload.js"),
  path.join(distDir, "pet-preload.js"),
);
console.log(`copied ${assets.join(", ")}, pet-preload.js -> dist/`);
