// Renderer slice 3 test helpers: a signed renderer written into a local-fs
// storage root under renderers/<sha>/…, with a throwaway P-256 key made by
// node:crypto per test run. No key file is ever written to the repository.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildManifest,
  canonicalManifestBytes,
  sha256Hex,
} from "@secure-test/renderer/manifest";
import { BRIDGE_REQUIRES } from "@secure-test/renderer/requires";

export type TestKey = { privateKey: KeyObject; publicPem: string };

export function makeTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

export function signBytes(key: TestKey, bytes: Uint8Array): Uint8Array {
  return new Uint8Array(sign("sha256", bytes, { key: key.privateKey, dsaEncoding: "der" }));
}

export const TEST_COMMIT = "0123456789abcdef0123456789abcdef01234567";

export interface WrittenRenderer {
  sha256: string;
  version: number;
  manifestBytes: Uint8Array;
  files: Record<string, Uint8Array>;
}

export async function writeObject(root: string, key: string, bytes: Uint8Array | string) {
  const target = join(root, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

/**
 * Builds, signs and stores one renderer; writes the pointer unless
 * `pointer: false`. Returns the manifest hash and version.
 */
export async function writeSignedRenderer(
  root: string,
  key: TestKey,
  opts: {
    version?: number;
    issuedAt?: Date;
    validityDays?: number;
    script?: string;
    pointer?: boolean;
  } = {},
): Promise<WrittenRenderer> {
  const files: Record<string, Uint8Array> = {
    "renderer.js": new TextEncoder().encode(opts.script ?? "window.placeholder = 1;\n"),
    "renderer.css": new TextEncoder().encode("body { margin: 0; }\n"),
  };
  const manifest = buildManifest({
    files,
    version: opts.version ?? 1_760_000_000,
    commit: TEST_COMMIT,
    requires: BRIDGE_REQUIRES,
    issuedAt: opts.issuedAt ?? new Date(),
    validityDays: opts.validityDays,
  });
  const manifestBytes = canonicalManifestBytes(manifest);
  const sha256 = sha256Hex(manifestBytes);
  await writeObject(root, `renderers/${sha256}/manifest.json`, manifestBytes);
  await writeObject(root, `renderers/${sha256}/manifest.sig`, signBytes(key, manifestBytes));
  for (const [name, bytes] of Object.entries(files)) {
    await writeObject(root, `renderers/${sha256}/${name}`, bytes);
  }
  if (opts.pointer !== false) {
    await writePointer(root, sha256, manifest.version);
  }
  return { sha256, version: manifest.version, manifestBytes, files };
}

export async function writePointer(root: string, sha256: string, version: number) {
  await writeObject(root, "renderers/current.json", JSON.stringify({ sha256, version }));
}
