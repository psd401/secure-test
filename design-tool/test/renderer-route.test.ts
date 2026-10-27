// Renderer slice 3 commit 4: GET /api/renderer/<sha256>/<file>. Files by
// manifest hash, for any student or staff session, immutable caching, and a
// 404 for any shape the route does not serve. Storage only — no database.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { makeTestKey, writeSignedRenderer, type WrittenRenderer } from "./helpers/renderer";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

let root: string;
let originalRoot: string | undefined;
let originalProvider: string | undefined;
let renderer: WrittenRenderer;

beforeAll(async () => {
  originalRoot = process.env.STORAGE_LOCAL_ROOT;
  originalProvider = process.env.STORAGE_PROVIDER;
  root = await mkdtemp(join(tmpdir(), "secure-test-renderer-route-"));
  process.env.STORAGE_LOCAL_ROOT = root;
  delete process.env.STORAGE_PROVIDER; // local-fs
  renderer = await writeSignedRenderer(root, makeTestKey());
});

afterEach(() => {
  principal = null;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalRoot;
  if (originalProvider === undefined) delete process.env.STORAGE_PROVIDER;
  else process.env.STORAGE_PROVIDER = originalProvider;
});

async function get(sha256: string, file: string) {
  const { GET } = await import("../app/api/renderer/[sha256]/[file]/route");
  return GET(new Request(`http://localhost/api/renderer/${sha256}/${file}`), {
    params: Promise.resolve({ sha256, file }),
  });
}

describe("GET /api/renderer/:sha256/:file", () => {
  test("401 without a session", async () => {
    const res = await get(renderer.sha256, "renderer.js");
    expect(res.status).toBe(401);
  });

  test("403 for a role that is neither student nor staff", async () => {
    principal = { sub: "g", role: "guardian" };
    expect((await get(renderer.sha256, "renderer.js")).status).toBe(403);
  });

  test("serves each of the four files to a student, with type and cache headers", async () => {
    principal = { sub: "student-sub", role: "student" };
    const expected: Record<string, [string, Uint8Array]> = {
      "renderer.js": ["text/javascript", renderer.files["renderer.js"]!],
      "renderer.css": ["text/css", renderer.files["renderer.css"]!],
      "manifest.json": ["application/json", renderer.manifestBytes],
      "manifest.sig": ["application/octet-stream", new Uint8Array()],
    };
    for (const [file, [type, bytes]] of Object.entries(expected)) {
      const res = await get(renderer.sha256, file);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = new Uint8Array(await res.arrayBuffer());
      if (file === "manifest.sig") expect(body.byteLength).toBeGreaterThan(8);
      else expect(Array.from(body)).toEqual(Array.from(bytes));
    }
  });

  test("serves a staff session too (practice sittings run the same shell)", async () => {
    principal = { sub: "teacher-sub", role: "staff" };
    expect((await get(renderer.sha256, "renderer.css")).status).toBe(200);
  });

  test("404 for a malformed hash or a file name outside the four", async () => {
    principal = { sub: "student-sub", role: "student" };
    for (const [sha, file] of [
      [renderer.sha256.toUpperCase(), "renderer.js"],
      [renderer.sha256.slice(1), "renderer.js"],
      [`${renderer.sha256}0`, "renderer.js"],
      ["../" + renderer.sha256.slice(3), "renderer.js"],
      [renderer.sha256, "current.json"],
      [renderer.sha256, "../current.json"],
      [renderer.sha256, "renderer.map"],
      [renderer.sha256, "RENDERER.JS"],
    ] as const) {
      expect((await get(sha, file)).status).toBe(404);
    }
  });

  test("404 for a well-formed hash with nothing stored", async () => {
    principal = { sub: "student-sub", role: "student" };
    expect((await get("c".repeat(64), "renderer.js")).status).toBe(404);
  });
});
