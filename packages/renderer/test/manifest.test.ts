import { describe, expect, test } from "bun:test";
import {
  buildManifest,
  canonicalManifestBytes,
  parseManifest,
  type RendererManifest,
} from "../src/manifest";
import { BRIDGE_REQUIRES, REQUIREMENTS } from "../src/requires";

const enc = new TextEncoder();
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ISSUED = new Date("2026-10-13T17:00:00.000Z");

// Known SHA-256 values.
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function sample(overrides: Partial<Parameters<typeof buildManifest>[0]> = {}) {
  return buildManifest({
    files: { "renderer.js": enc.encode("abc"), "renderer.css": new Uint8Array() },
    version: 1_760_000_000,
    commit: COMMIT,
    requires: ["submit", "response", "home"],
    issuedAt: ISSUED,
    ...overrides,
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("buildManifest", () => {
  test("hashes and sizes the file bytes", () => {
    const m = sample();
    expect(m.files["renderer.js"]).toEqual({ sha256: ABC_SHA, bytes: 3 });
    expect(m.files["renderer.css"]).toEqual({ sha256: EMPTY_SHA, bytes: 0 });
    expect(m.format).toBe(1);
    expect(m.commit).toBe(COMMIT);
  });

  test("not_after is issued_at + 60 days by default, UTC with Z", () => {
    const m = sample();
    expect(m.issued_at).toBe("2026-10-13T17:00:00.000Z");
    expect(m.not_after).toBe("2026-12-12T17:00:00.000Z");
    expect(sample({ validityDays: 1 }).not_after).toBe("2026-10-14T17:00:00.000Z");
  });

  test("requires is sorted and de-duplicated", () => {
    const m = sample({ requires: ["submit", "home", "response", "home", "submit"] });
    expect(m.requires).toEqual(["home", "response", "submit"]);
  });

  test("an unknown requirement is rejected", () => {
    expect(() => sample({ requires: ["response", "camera"] })).toThrow(/unknown requirement/);
  });

  test("the bridge renderer's requirements are all in the vocabulary", () => {
    expect(REQUIREMENTS).toHaveLength(10);
    expect(() => sample({ requires: BRIDGE_REQUIRES })).not.toThrow();
  });

  test("a bad commit is rejected", () => {
    for (const commit of ["abc123", COMMIT.toUpperCase(), `${COMMIT}0`, `${COMMIT.slice(0, 39)}g`]) {
      expect(() => sample({ commit })).toThrow(/commit/);
    }
  });

  test("a bad version is rejected", () => {
    for (const version of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => sample({ version })).toThrow(/version/);
    }
  });

  test("an unsafe file name is rejected", () => {
    for (const name of ["../x.js", "a/b.js", "Renderer.js", ".hidden"]) {
      expect(() => sample({ files: { [name]: enc.encode("x") } })).toThrow(/file name/);
    }
  });
});

describe("canonicalManifestBytes", () => {
  test("is compact, key-sorted JSON", () => {
    const m = sample();
    expect(text(canonicalManifestBytes(m))).toBe(
      `{"commit":"${COMMIT}","files":{"renderer.css":{"bytes":0,"sha256":"${EMPTY_SHA}"},` +
        `"renderer.js":{"bytes":3,"sha256":"${ABC_SHA}"}},"format":1,` +
        `"issued_at":"2026-10-13T17:00:00.000Z","not_after":"2026-12-12T17:00:00.000Z",` +
        `"requires":["home","response","submit"],"version":1760000000}`,
    );
  });

  test("is independent of key order", () => {
    const m = sample();
    const shuffled = {
      version: m.version,
      requires: m.requires,
      files: {
        "renderer.js": { bytes: 3, sha256: ABC_SHA },
        "renderer.css": { sha256: EMPTY_SHA, bytes: 0 },
      },
      not_after: m.not_after,
      issued_at: m.issued_at,
      commit: m.commit,
      format: 1,
    } as RendererManifest;
    expect(canonicalManifestBytes(shuffled)).toEqual(canonicalManifestBytes(m));
  });

  test("equal manifests give identical bytes", () => {
    expect(canonicalManifestBytes(sample())).toEqual(canonicalManifestBytes(sample()));
  });
});

describe("parseManifest", () => {
  test("round-trips canonical bytes", () => {
    const m = sample();
    expect(parseManifest(canonicalManifestBytes(m))).toEqual(m);
  });

  function mutated(edit: (o: Record<string, any>) => void): Uint8Array {
    const o = JSON.parse(text(canonicalManifestBytes(sample())));
    edit(o);
    return canonicalManifestBytes(o);
  }

  test("rejects malformed input", () => {
    const bad: Array<[string, Uint8Array]> = [
      ["not JSON", enc.encode("{")],
      ["an array", enc.encode("[]")],
      ["format 2", mutated((o) => (o.format = 2))],
      ["string version", mutated((o) => (o.version = "1"))],
      ["short commit", mutated((o) => (o.commit = "abc"))],
      ["no Z", mutated((o) => (o.issued_at = "2026-10-13T17:00:00.000"))],
      ["not_after first", mutated((o) => (o.not_after = "2026-10-01T00:00:00.000Z"))],
      ["unknown requirement", mutated((o) => (o.requires = ["camera"]))],
      ["unsorted requires", mutated((o) => (o.requires = ["submit", "home"]))],
      ["short sha256", mutated((o) => (o.files["renderer.js"].sha256 = "abc"))],
      ["uppercase sha256", mutated((o) => (o.files["renderer.js"].sha256 = ABC_SHA.toUpperCase()))],
      ["negative bytes", mutated((o) => (o.files["renderer.js"].bytes = -1))],
      ["empty files", mutated((o) => (o.files = {}))],
      ["extra key", mutated((o) => (o.extra = true))],
      ["missing key", mutated((o) => delete o.commit)],
      ["extra file field", mutated((o) => (o.files["renderer.js"].type = "js"))],
    ];
    for (const [label, bytes] of bad) {
      expect(() => parseManifest(bytes), label).toThrow();
    }
  });

  test("rejects non-canonical bytes of a valid manifest", () => {
    const pretty = enc.encode(JSON.stringify(sample(), null, 2));
    expect(() => parseManifest(pretty)).toThrow(/canonical/);
  });
});
