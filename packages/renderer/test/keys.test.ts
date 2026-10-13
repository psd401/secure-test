import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
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

  test("the generator refuses a private key", () => {
    expect(() =>
      renderKeysModule([{ name: "oops", pem: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }]),
    ).toThrow(/PRIVATE/);
  });
});
