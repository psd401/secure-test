import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey } from "node:crypto";
import { KEYS_MODULE, readPublicKeys, renderKeysModule } from "../scripts/keys-module";
import { RENDERER_PUBLIC_KEYS, RENDERER_PUBLIC_KEYS_BY_NAME } from "../src/keys";

describe("src/keys.ts", () => {
  test("matches keys/*.pub.pem (run `bun run keys` after changing a key)", () => {
    expect(readFileSync(KEYS_MODULE, "utf8")).toBe(renderKeysModule(readPublicKeys()));
  });

  test("carries the working key, every entry a P-256 public key", () => {
    expect(Object.keys(RENDERER_PUBLIC_KEYS_BY_NAME)).toContain("working");
    expect(RENDERER_PUBLIC_KEYS.length).toBe(Object.keys(RENDERER_PUBLIC_KEYS_BY_NAME).length);
    for (const pem of RENDERER_PUBLIC_KEYS) {
      const key = createPublicKey(pem);
      expect(key.asymmetricKeyType).toBe("ec");
      expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    }
  });

  // The backup key (a hardware token IT holds): its DER public key hashes to
  // the fingerprint IT sent with it (2026-10-13), so this copy is the key
  // generated on the token. The rehearsal's signed manifest becomes a fixture
  // proving the token's signatures verify (slice 3b).
  test("carries the backup key, with the fingerprint IT sent", () => {
    const backup = RENDERER_PUBLIC_KEYS_BY_NAME.backup;
    expect(backup).toBeDefined();
    const der = createPublicKey(backup!).export({ type: "spki", format: "der" });
    expect(createHash("sha256").update(der).digest("hex")).toBe(
      "39395eda0e79e07c3193ad56698f4b98df8b925c866198d74c56f0e932e2608f", // gitleaks:allow (a public-key fingerprint, not a secret)
    );
  });

  test("the generator refuses a private key", () => {
    expect(() =>
      renderKeysModule([{ name: "oops", pem: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }]),
    ).toThrow(/PRIVATE/);
  });
});
