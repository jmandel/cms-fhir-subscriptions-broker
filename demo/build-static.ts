// Build the demo into a static site in docs/ for GitHub Pages.
// Usage: bun run demo/build-static.ts
// Env: BASE_PATH (optional, e.g. "/cms-networks")

import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";

const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const DEMO_DIR = dirname(import.meta.filename);
const OUT_DIR = join(DEMO_DIR, "..", "docs");

mkdirSync(OUT_DIR, { recursive: true });

// Bundle the TSX app
const result = await Bun.build({
  entrypoints: [join(DEMO_DIR, "index.tsx")],
  outdir: OUT_DIR,
  target: "browser",
  format: "esm",
  naming: "app.[hash].js",
});

if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

const jsFilename = result.outputs[0].path.split("/").pop()!;

// Generate index.html from template
const html = readFileSync(join(DEMO_DIR, "public", "index.html"), "utf-8")
  .replace(
    '<script type="module" src="/index.tsx"></script>',
    `<script type="module" src="${BASE_PATH}/${jsFilename}"></script>`
  );

writeFileSync(join(OUT_DIR, "index.html"), html);

console.log(`Built to ${OUT_DIR}: index.html + ${jsFilename}`);
