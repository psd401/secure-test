// Builds the served renderer files and their manifest into dist/.
//
//   bun run build   (from packages/renderer)
//
// - version = HEAD's committer time in unix seconds. `main` has linear
//   history (branch protection), so this rises with every commit on it and
//   serves the shell's minimum-version check (D-2).
// - commit  = HEAD's full SHA.
// - issued_at = now; not_after = +60 days (2.a).
// dist/manifest.json holds the canonical bytes — the exact bytes deploy.sh
// signs. Signing and serving are not done here.
//
// Bridge mode (D-9): renderer.js and renderer.css are EXTRACTED from the
// client's Swift literals (scripts/extract-swift.ts), byte-identical to what
// a v1.x client builds at run time. scripts/check-extraction.sh proves that
// against Swift itself (macOS; deploy.sh runs it before signing).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, canonicalManifestBytes } from "../src/manifest";
import { BRIDGE_REQUIRES } from "../src/requires";
import { CLIENT_SOURCES, extractRenderer } from "./extract-swift";

const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
const dist = join(root, "dist");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const { js, css } = extractRenderer(
  CLIENT_SOURCES.map((file) => ({ file, source: readFileSync(join(repo, file), "utf8") })),
);

// The shell inlines renderer.js into a <script> element and renderer.css into
// a <style> element; `</` in either could close it early.
if (js.includes("</")) throw new Error("renderer.js must not contain the sequence </");
if (css.includes("</")) throw new Error("renderer.css must not contain the sequence </");

const enc = new TextEncoder();
const files: Record<string, Uint8Array> = {
  "renderer.js": enc.encode(js),
  "renderer.css": enc.encode(css),
};

const manifest = buildManifest({
  files,
  version: Number(git("log", "-1", "--format=%ct")),
  commit: git("rev-parse", "HEAD"),
  requires: BRIDGE_REQUIRES,
  issuedAt: new Date(),
});

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(dist, name), bytes);
}
writeFileSync(join(dist, "manifest.json"), canonicalManifestBytes(manifest));

console.log(
  `renderer v${manifest.version} @ ${manifest.commit.slice(0, 10)}: ` +
    Object.entries(manifest.files)
      .map(([n, f]) => `${n} ${f.bytes} B`)
      .join(", ") +
    `; requires ${manifest.requires.join(",")}; not_after ${manifest.not_after}`,
);
