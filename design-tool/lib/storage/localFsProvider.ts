import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StorageProvider } from "./types";

// localFsProvider stores assets on the local filesystem under
// STORAGE_LOCAL_ROOT (default ./storage). Slice-10 default for dev; an
// S3Provider will join it later (ADR 0008). The storage_key is just the
// asset UUID — no per-owner directory yet; the assets table is the
// authoritative ACL.

function resolveRoot(): string {
  const raw = process.env.STORAGE_LOCAL_ROOT ?? "./storage";
  return resolve(raw);
}

function pathFor(storage_key: string): string {
  return join(resolveRoot(), storage_key);
}

export const localFsProvider: StorageProvider = {
  id: "local-fs",

  async put({ id, bytes }) {
    const target = pathFor(id);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { storage_key: id };
  },

  async get(storage_key) {
    const target = pathFor(storage_key);
    const buf = await readFile(target);
    return new Uint8Array(buf);
  },

  async delete(storage_key) {
    const target = pathFor(storage_key);
    await rm(target, { force: true });
  },

  // Finding 10.10: local-fs never hands out a direct URL, so in practice a
  // pending slot here has no file — but the contract is the same, and the
  // tests exercise the settle path through it.
  async head(storage_key) {
    try {
      const info = await stat(pathFor(storage_key));
      return info.isFile() ? { size: info.size } : null;
    } catch (err) {
      if ((err as { code?: string })?.code === "ENOENT") return null;
      throw err;
    }
  },
};
