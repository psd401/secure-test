// Verifying a signed renderer manifest (docs/server-delivered-renderer-design.md
// D-2, 2.a). Pure: node:crypto only, no file or network I/O.
//
// The signature is ECDSA P-256 over SHA-256 of the EXACT manifest bytes
// (canonicalManifestBytes — dist/manifest.json), DER-encoded. It is made by
// tools/renderer-sign (the working key in the maintainer's Secure Enclave,
// or a DEV key for local and Debug use). Both the working and the backup
// public keys are P-256, so one code path covers both; the client shell
// makes the same check in Swift (slice 4).
//
// Signature first, then use: a caller verifies the bytes, parses them
// (parseManifest), then asks checkManifestUse whether this manifest may be
// used now.

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { RendererManifest } from "./manifest";

function p256Key(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (err) {
    throw new Error(`not a PEM public key: ${(err as Error).message}`);
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    throw new Error(
      `renderer keys are ECDSA P-256; got ${key.asymmetricKeyType}${curve ? ` (${curve})` : ""}`,
    );
  }
  return key;
}

// True when ANY of the keys verifies the DER signature over the bytes. A
// malformed or truncated signature is false. A key that is not P-256 (or not
// a key) throws: the key list is configuration, and a wrong entry there must
// be loud rather than silently never matching.
export function verifyManifestSignature(
  manifestBytes: Uint8Array,
  derSignature: Uint8Array,
  publicKeysPem: string[],
): boolean {
  if (publicKeysPem.length === 0) throw new Error("no public keys to verify against");
  const keys = publicKeysPem.map(p256Key);
  for (const key of keys) {
    try {
      if (verify("sha256", manifestBytes, { key, dsaEncoding: "der" }, derSignature)) {
        return true;
      }
    } catch {
      // OpenSSL rejects some malformed DER by throwing rather than returning
      // false; either way this key does not verify it.
    }
  }
  return false;
}

export type ManifestUse =
  | { ok: true }
  | { ok: false; reason: "expired" | "not_yet_valid" | "below_min_version" };

// May this (already signature-checked and parsed) manifest be used at `now`?
// Refused below the minimum version (D-2) and outside the signed validity
// window [issued_at, not_after] (2.a), both ends inclusive.
export function checkManifestUse(
  manifest: Pick<RendererManifest, "version" | "issued_at" | "not_after">,
  { now, minVersion }: { now: Date; minVersion: number },
): ManifestUse {
  if (manifest.version < minVersion) return { ok: false, reason: "below_min_version" };
  const t = now.getTime();
  if (Number.isNaN(t)) throw new Error("now must be a valid Date");
  if (t < Date.parse(manifest.issued_at)) return { ok: false, reason: "not_yet_valid" };
  if (t > Date.parse(manifest.not_after)) return { ok: false, reason: "expired" };
  return { ok: true };
}
