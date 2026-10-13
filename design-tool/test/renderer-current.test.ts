// Renderer slice 3 commit 4 (docs/server-delivered-renderer-design.md): which
// signed renderer a delivery bundle names. The pointer is trusted for
// nothing — every check the shell will make is made here first, and a
// failure is logged at WARN and names no renderer. No database.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink } from "../lib/log";
import { createRendererResolver, isMissingObject } from "../lib/renderer/current";
import { localFsProvider } from "../lib/storage/localFsProvider";
import {
  makeTestKey,
  writeObject,
  writePointer,
  writeSignedRenderer,
} from "./helpers/renderer";

const key = makeTestKey();
const otherKey = makeTestKey();
let root: string;
let originalRoot: string | undefined;
let lines: Array<Record<string, unknown>> = [];
const restoreSink = setLogSink((line) => lines.push(JSON.parse(line)));

beforeAll(() => {
  originalRoot = process.env.STORAGE_LOCAL_ROOT;
});

beforeEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "secure-test-renderer-"));
  process.env.STORAGE_LOCAL_ROOT = root;
  lines = [];
});

afterAll(async () => {
  setLogSink(restoreSink);
  if (root) await rm(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalRoot;
});

let clock = Date.now();
function resolver(publicKeys = [key.publicPem]) {
  return createRendererResolver({
    storage: () => localFsProvider,
    publicKeys,
    now: () => new Date(clock),
  });
}

function warnings() {
  return lines.filter((l) => l.level === "warn");
}

describe("current renderer resolution", () => {
  test("no pointer → null, and nothing logged", async () => {
    expect(await resolver().current()).toBeNull();
    expect(lines).toEqual([]);
  });

  test("a valid signed renderer is named by manifest hash and version", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    expect(await resolver().current()).toEqual({ sha256: r.sha256, version: r.version });
    expect(warnings()).toEqual([]);
  });

  test("any of the trusted keys verifies (working or backup)", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    expect(await resolver([otherKey.publicPem, key.publicPem]).current()).toEqual({
      sha256: r.sha256,
      version: r.version,
    });
  });

  test("a tampered manifest under the same hash → null + warn manifest_hash_mismatch", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    const tampered = new TextDecoder().decode(r.manifestBytes).replace('"format":1', '"format":2');
    await writeObject(root, `renderers/${r.sha256}/manifest.json`, tampered);
    expect(await resolver().current()).toBeNull();
    expect(warnings()).toEqual([
      expect.objectContaining({ event: "renderer_current_invalid", reason: "manifest_hash_mismatch", sha256: r.sha256 }),
    ]);
  });

  test("a renderer signed by an untrusted key → null + warn bad_signature", async () => {
    clock = Date.now();
    await writeSignedRenderer(root, otherKey, { issuedAt: new Date(clock - 1000) });
    expect(await resolver().current()).toBeNull();
    expect(warnings()).toEqual([
      expect.objectContaining({ event: "renderer_current_invalid", reason: "bad_signature" }),
    ]);
  });

  test("a garbage signature → null + warn bad_signature", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    await writeObject(root, `renderers/${r.sha256}/manifest.sig`, new Uint8Array([0x30, 0x02, 0x00]));
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "bad_signature" });
  });

  test("an expired renderer → null + warn expired; not yet valid → not_yet_valid", async () => {
    clock = Date.now();
    await writeSignedRenderer(root, key, {
      issuedAt: new Date(clock - 61 * 24 * 3600 * 1000),
      validityDays: 60,
    });
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "expired" });

    lines = [];
    await writeSignedRenderer(root, key, { issuedAt: new Date(clock + 3600 * 1000) });
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "not_yet_valid" });
  });

  test("a served file that does not match the manifest → null + warn file_mismatch", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    await writeObject(root, `renderers/${r.sha256}/renderer.js`, "alert('swapped');\n");
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "file_mismatch" });

    lines = [];
    await unlink(join(root, `renderers/${r.sha256}/renderer.css`));
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "file_mismatch" });
  });

  test("a pointer whose version disagrees with the manifest → version_mismatch", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    await writePointer(root, r.sha256, r.version + 1);
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "version_mismatch" });
  });

  test("a malformed pointer or a pointer to nothing → null + warn", async () => {
    await writeObject(root, "renderers/current.json", "{not json");
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "pointer_malformed" });

    lines = [];
    await writeObject(root, "renderers/current.json", JSON.stringify({ sha256: "A".repeat(64), version: 1 }));
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "pointer_malformed" });

    lines = [];
    await writePointer(root, "b".repeat(64), 1);
    expect(await resolver().current()).toBeNull();
    expect(warnings()[0]).toMatchObject({ reason: "manifest_missing" });
  });

  test("a result is cached 60 s — a renderer and a failure alike", async () => {
    clock = Date.now();
    const r = await writeSignedRenderer(root, key, { issuedAt: new Date(clock - 1000) });
    const res = resolver();
    expect(await res.current()).toEqual({ sha256: r.sha256, version: r.version });

    // The pointer goes away; the cached answer stands until the TTL passes.
    await unlink(join(root, "renderers/current.json"));
    clock += 59_000;
    expect(await res.current()).toEqual({ sha256: r.sha256, version: r.version });
    clock += 2_000;
    expect(await res.current()).toBeNull();

    // A failure is cached too: a bad pointer fixed within the minute is seen
    // only after it.
    await writePointer(root, r.sha256, r.version + 1);
    clock += 61_000;
    expect(await res.current()).toBeNull();
    await writePointer(root, r.sha256, r.version);
    clock += 30_000;
    expect(await res.current()).toBeNull();
    clock += 31_000;
    expect(await res.current()).toEqual({ sha256: r.sha256, version: r.version });
  });
});

describe("isMissingObject", () => {
  test("local-fs ENOENT and S3 404 / 403 (no ListBucket) are missing; other errors are not", () => {
    expect(isMissingObject(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingObject(new Error("storage_s3_error_404: NoSuchKey"))).toBe(true);
    expect(isMissingObject(new Error("storage_s3_error_403: Access Denied"))).toBe(true);
    expect(isMissingObject(new Error("storage_s3_error_500: boom"))).toBe(false);
    expect(isMissingObject(new Error("S3_BUCKET is not set"))).toBe(false);
  });
});
