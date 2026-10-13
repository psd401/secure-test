import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, canonicalManifestBytes, parseManifest } from "../src/manifest";
import { checkManifestUse, verifyManifestSignature } from "../src/verify";

const enc = new TextEncoder();

function manifestBytes(): Uint8Array {
  return canonicalManifestBytes(
    buildManifest({
      files: { "renderer.js": enc.encode("abc"), "renderer.css": new Uint8Array() },
      version: 1_760_000_000,
      commit: "0123456789abcdef0123456789abcdef01234567",
      requires: ["home", "response", "submit"],
      issuedAt: new Date("2026-10-13T17:00:00.000Z"),
    }),
  );
}

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, pem: publicKey.export({ type: "spki", format: "pem" }) as string };
}

function derSign(bytes: Uint8Array, key: KeyObject): Uint8Array {
  return sign("sha256", bytes, { key, dsaEncoding: "der" });
}

describe("verifyManifestSignature", () => {
  test("a P-256 signature over the canonical bytes verifies", () => {
    const k = p256();
    const bytes = manifestBytes();
    expect(verifyManifestSignature(bytes, derSign(bytes, k.privateKey), [k.pem])).toBe(true);
  });

  test("a tampered byte fails", () => {
    const k = p256();
    const bytes = manifestBytes();
    const sig = derSign(bytes, k.privateKey);
    const tampered = bytes.slice();
    tampered[20] = tampered[20]! ^ 0x01;
    expect(verifyManifestSignature(tampered, sig, [k.pem])).toBe(false);
  });

  test("the wrong key fails", () => {
    const bytes = manifestBytes();
    const sig = derSign(bytes, p256().privateKey);
    expect(verifyManifestSignature(bytes, sig, [p256().pem])).toBe(false);
  });

  test("a truncated, empty or raw (non-DER) signature fails", () => {
    const k = p256();
    const bytes = manifestBytes();
    const sig = derSign(bytes, k.privateKey);
    expect(verifyManifestSignature(bytes, sig.subarray(0, sig.length - 3), [k.pem])).toBe(false);
    expect(verifyManifestSignature(bytes, new Uint8Array(), [k.pem])).toBe(false);
    const raw = sign("sha256", bytes, { key: k.privateKey, dsaEncoding: "ieee-p1363" });
    expect(verifyManifestSignature(bytes, raw, [k.pem])).toBe(false);
  });

  test("any one of several keys verifies (working + backup)", () => {
    const working = p256();
    const backup = p256();
    const bytes = manifestBytes();
    const byBackup = derSign(bytes, backup.privateKey);
    expect(verifyManifestSignature(bytes, byBackup, [working.pem, backup.pem])).toBe(true);
    expect(verifyManifestSignature(bytes, byBackup, [working.pem])).toBe(false);
  });

  test("an Ed25519 or P-384 key is rejected", () => {
    const bytes = manifestBytes();
    const k = p256();
    const sig = derSign(bytes, k.privateKey);
    const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(() => verifyManifestSignature(bytes, sig, [ed])).toThrow(/P-256/);
    expect(() => verifyManifestSignature(bytes, sig, [p384])).toThrow(/P-256/);
    // A bad entry is loud even beside a good key.
    expect(() => verifyManifestSignature(bytes, sig, [k.pem, ed])).toThrow(/P-256/);
    expect(() => verifyManifestSignature(bytes, sig, ["not a key"])).toThrow(/PEM/);
    expect(() => verifyManifestSignature(bytes, sig, [])).toThrow(/no public keys/);
  });
});

describe("checkManifestUse", () => {
  const m = parseManifest(manifestBytes()); // 2026-10-13T17:00Z … 2026-12-12T17:00Z
  const min = 1_760_000_000;

  test("inside the window at or above the minimum version", () => {
    expect(checkManifestUse(m, { now: new Date("2026-11-01T00:00:00Z"), minVersion: min })).toEqual({ ok: true });
    expect(checkManifestUse(m, { now: new Date(m.issued_at), minVersion: 1 })).toEqual({ ok: true });
    expect(checkManifestUse(m, { now: new Date(m.not_after), minVersion: 1 })).toEqual({ ok: true });
  });

  test("before issued_at", () => {
    expect(checkManifestUse(m, { now: new Date("2026-10-13T16:59:59.999Z"), minVersion: min })).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
  });

  test("after not_after", () => {
    expect(checkManifestUse(m, { now: new Date("2026-12-12T17:00:00.001Z"), minVersion: min })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("below the minimum version", () => {
    expect(checkManifestUse(m, { now: new Date("2026-11-01T00:00:00Z"), minVersion: min + 1 })).toEqual({
      ok: false,
      reason: "below_min_version",
    });
  });
});

// Cross-language: manifest.sig was made by the Swift tool (tools/renderer-sign,
// CryptoKit) with a throwaway DEV key that never entered the repository; only
// its public half is committed. This proves the Swift signer and this
// verifier agree on the bytes, the hash and the DER encoding. The Swift
// tests verify the same three files.
//
// To regenerate (keys outside the repo; delete the private key after):
//   1. From packages/renderer, write fixtures/cross-language/manifest.json as
//      canonicalManifestBytes(buildManifest(FIXTURE_INPUT)) — e.g. a
//      throwaway script importing ./src/manifest with the inputs below.
//   2. cd tools/renderer-sign && swift build -c release
//   3. .build/release/renderer-sign create-dev-key --out "$TMPDIR/x.pem" \
//        > ../../packages/renderer/test/fixtures/cross-language/public.pem
//   4. .build/release/renderer-sign sign \
//        ../../packages/renderer/test/fixtures/cross-language/manifest.json \
//        --out ../../packages/renderer/test/fixtures/cross-language/manifest.sig \
//        --dev-key "$TMPDIR/x.pem"
//   5. rm "$TMPDIR/x.pem"
describe("cross-language fixture (signed by tools/renderer-sign)", () => {
  const dir = join(import.meta.dir, "fixtures", "cross-language");
  const bytes = new Uint8Array(readFileSync(join(dir, "manifest.json")));
  const sig = new Uint8Array(readFileSync(join(dir, "manifest.sig")));
  const pem = readFileSync(join(dir, "public.pem"), "utf8");

  const FIXTURE_INPUT = {
    files: { "renderer.js": enc.encode("// cross-language fixture\n"), "renderer.css": enc.encode("body{}\n") },
    version: 1_760_000_000,
    commit: "0123456789abcdef0123456789abcdef01234567",
    requires: ["home", "response", "submit"],
    issuedAt: new Date("2026-10-13T17:00:00.000Z"),
  };

  test("the fixture is this package's canonical form of the inputs", () => {
    expect(Buffer.from(bytes).equals(Buffer.from(canonicalManifestBytes(buildManifest(FIXTURE_INPUT))))).toBe(true);
  });

  test("the Swift-made signature verifies here", () => {
    expect(verifyManifestSignature(bytes, sig, [pem])).toBe(true);
  });

  test("and fails on a changed byte or another key", () => {
    const tampered = bytes.slice();
    tampered[10] = tampered[10]! ^ 0x01;
    expect(verifyManifestSignature(tampered, sig, [pem])).toBe(false);
    expect(verifyManifestSignature(bytes, sig, [p256().pem])).toBe(false);
  });
});
