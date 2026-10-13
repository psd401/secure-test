// Builds the served renderer files and their manifest into dist/.
//
//   bun run build   (from packages/renderer)
//
// - version = HEAD's committer time in unix seconds. `main` has linear
//   history (branch protection), so this rises with every commit on it and
//   serves the shell's minimum-version check (D-2).
// - commit  = HEAD's full SHA.
// - issued_at = now; not_after = +60 days (2.a).
// dist/manifest.json holds the canonical bytes — the exact bytes the next
// commit signs. Signing and serving are not done here.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, canonicalManifestBytes } from "../src/manifest";
import { PLACEHOLDER_REQUIRES } from "../src/requires";

const root = join(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const files: Record<string, Uint8Array> = {
  "renderer.js": readFileSync(join(src, "renderer.js")),
  "renderer.css": readFileSync(join(src, "renderer.css")),
};

// The client inlines renderer.js into a <script> element.
if (new TextDecoder().decode(files["renderer.js"]).includes("</")) {
  throw new Error("src/renderer.js must not contain the sequence </");
}

const manifest = buildManifest({
  files,
  version: Number(git("log", "-1", "--format=%ct")),
  commit: git("rev-parse", "HEAD"),
  requires: PLACEHOLDER_REQUIRES,
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
