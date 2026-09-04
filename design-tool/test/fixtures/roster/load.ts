// Loads a roster extract fixture from disk into the shape `validateExtract` /
// `importSnapshot` take, with hooks for the refusal cases: a file can be
// dropped, replaced or tampered with, and the manifest edited, without
// writing a fixture directory per failure mode.
//
// Every person in these fixtures is fictional. Nothing here came from the
// warehouse.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, type ReadExtractFile } from "../../../lib/roster/extract";

export const ROSTER_FIXTURES = import.meta.dir;

export interface LoadedExtract {
  manifest: Record<string, unknown> & { files: Record<string, { path: string; rows: number; sha256: string }> };
  files: Map<string, Uint8Array>;
  readFile: ReadExtractFile;
}

export async function loadExtract(name = "complete"): Promise<LoadedExtract> {
  const dir = join(ROSTER_FIXTURES, name);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const files = new Map<string, Uint8Array>();
  for (const entry of Object.values(manifest.files) as { path: string }[]) {
    files.set(entry.path, new Uint8Array(await readFile(join(dir, entry.path))));
  }
  return {
    manifest,
    files,
    readFile: async (path) => files.get(path) ?? null,
  };
}

/** Replace one file's bytes AND fix up its manifest entry (count + checksum),
 * so the result is a valid extract with different content. */
export function replaceFile(
  extract: LoadedExtract,
  table: string,
  csv: string,
): LoadedExtract {
  const bytes = new TextEncoder().encode(csv);
  const entry = extract.manifest.files[table]!;
  extract.files.set(entry.path, bytes);
  entry.rows = csv.trim().split("\n").length - 1;
  entry.sha256 = sha256Hex(bytes);
  return extract;
}

/** Replace one file's bytes WITHOUT touching the manifest — the tamper case. */
export function tamperFile(extract: LoadedExtract, table: string, csv: string): LoadedExtract {
  const entry = extract.manifest.files[table]!;
  extract.files.set(entry.path, new TextEncoder().encode(csv));
  return extract;
}

export function dropFile(extract: LoadedExtract, table: string): LoadedExtract {
  extract.files.delete(extract.manifest.files[table]!.path);
  return extract;
}

export function withSnapshotId(extract: LoadedExtract, id: string): LoadedExtract {
  extract.manifest.snapshot_id = id;
  return extract;
}
