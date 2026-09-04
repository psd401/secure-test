// Slice 76: import a roster extract from a directory on disk.
//
//   DATABASE_URL=postgres://... bun scripts/roster-import-local.ts <dir>
//
// The manual counterpart of the S3 Lambda: same importer, same refusal
// rules, same counts-only log line — the directory just stands in for the
// snapshot prefix. This is how the data engineer's first real extract gets validated
// before any bucket exists, and how a night's snapshot can be re-imported
// by hand from a local copy.
//
// Prints one JSON line and exits 0 on success, 1 on refusal, 2 on misuse.
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { closeDb, getDb } from "../db/client";
import { runSync, type SnapshotSource } from "../lib/roster/syncHandler";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun scripts/roster-import-local.ts <snapshot-directory>");
  process.exit(2);
}
const root = resolve(dir);
try {
  if (!(await stat(root)).isDirectory()) throw new Error();
} catch {
  console.error(`not a directory: ${root}`);
  process.exit(2);
}

class DirectorySource implements SnapshotSource {
  async readManifest(): Promise<unknown | null> {
    const bytes = await this.readFile("", "manifest.json");
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }
  async readFile(_snapshotId: string, path: string): Promise<Uint8Array | null> {
    // Bare names only, same rule as the S3 source.
    if (basename(path) !== path) return null;
    try {
      return new Uint8Array(await readFile(join(root, path)));
    } catch {
      return null;
    }
  }
}

// The snapshot id is the manifest's, not the directory's; the source ignores
// the id it is handed. The label below is only for the log line.
const label = basename(root);
const result = await runSync(getDb(), new DirectorySource(), label);
await closeDb();
process.exit(result.ok ? 0 : 1);
