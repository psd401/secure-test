import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`uploads-api tests require the test DB; got ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let originalStorageRoot: string | undefined;
let tmpRoot: string;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff" } : null,
}));

function asUser(sub: string | null) {
  mockSub = sub;
}

beforeAll(async () => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  tmpRoot = await mkdtemp(join(tmpdir(), "secure-test-uploads-"));
  originalStorageRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = tmpRoot;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assets restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  if (originalStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalStorageRoot;
  await rm(tmpRoot, { recursive: true, force: true });
});

// Minimal valid PNG: 1x1 transparent pixel.
const PNG_1X1 = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
  120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

async function postUpload(
  fileBytes: Uint8Array,
  opts: { contentType?: string; filename?: string } = {},
) {
  const { POST } = await import("../app/api/uploads/image/route");
  const form = new FormData();
  const blob = new Blob([fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength) as ArrayBuffer], {
    type: opts.contentType ?? "image/png",
  });
  form.append("file", blob, opts.filename ?? "tiny.png");
  const req = new Request("http://localhost/api/uploads/image", {
    method: "POST",
    body: form,
  });
  return POST(req);
}

async function getAsset(id: string) {
  const { GET } = await import("../app/api/assets/[id]/route");
  const req = new Request(`http://localhost/api/assets/${id}`);
  return GET(req, { params: Promise.resolve({ id }) });
}

async function deleteAsset(id: string) {
  const { DELETE } = await import("../app/api/assets/[id]/route");
  const req = new Request(`http://localhost/api/assets/${id}`, { method: "DELETE" });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe("POST /api/uploads/image", () => {
  test("401 with no session", async () => {
    asUser(null);
    const res = await postUpload(PNG_1X1);
    expect(res.status).toBe(401);
  });

  test("201 creates asset row + persists bytes; round-trip via GET matches", async () => {
    asUser("teacher-1");
    const res = await postUpload(PNG_1X1, { filename: "smoke.png" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      asset: { id: string; owner_sub: string; content_type: string; size_bytes: number; storage_provider: string };
      deduped: boolean;
    };
    expect(body.deduped).toBe(false);
    expect(body.asset.owner_sub).toBe("teacher-1");
    expect(body.asset.content_type).toBe("image/png");
    expect(body.asset.size_bytes).toBe(PNG_1X1.byteLength);
    expect(body.asset.storage_provider).toBe("local-fs");

    const getRes = await getAsset(body.asset.id);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect(getRes.headers.get("cache-control")).toContain("private");
    const ab = await getRes.arrayBuffer();
    const got = new Uint8Array(ab);
    expect(Array.from(got)).toEqual(Array.from(PNG_1X1));
  });

  test("uploading identical bytes twice returns deduped: true and the same id", async () => {
    asUser("teacher-1");
    const a = await postUpload(PNG_1X1);
    const b = await postUpload(PNG_1X1);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    const aBody = (await a.json()) as { asset: { id: string } };
    const bBody = (await b.json()) as { asset: { id: string }; deduped: boolean };
    expect(bBody.deduped).toBe(true);
    expect(bBody.asset.id).toBe(aBody.asset.id);
  });

  test("415 for non-image content_type", async () => {
    asUser("teacher-1");
    const res = await postUpload(new Uint8Array([1, 2, 3]), {
      contentType: "application/pdf",
      filename: "doc.pdf",
    });
    expect(res.status).toBe(415);
  });

  // B7: SVG is an active document — it can carry <script> — and
  // /api/assets/[id] serves stored bytes inline on the app origin with the
  // row's own content type, so an accepted SVG is a stored-XSS primitive.
  test("415 for image/svg+xml (B7)", async () => {
    asUser("teacher-1");
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const res = await postUpload(svg, {
      contentType: "image/svg+xml",
      filename: "payload.svg",
    });
    expect(res.status).toBe(415);
  });

  test("413 when file exceeds 5 MB", async () => {
    asUser("teacher-1");
    const big = new Uint8Array(5 * 1024 * 1024 + 100);
    big.fill(0);
    const res = await postUpload(big);
    expect(res.status).toBe(413);
  });

  test("400 for empty file", async () => {
    asUser("teacher-1");
    const res = await postUpload(new Uint8Array(0));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/assets/[id]", () => {
  test("403 when fetching another user's asset", async () => {
    asUser("teacher-1");
    const created = await postUpload(PNG_1X1);
    const body = (await created.json()) as { asset: { id: string } };
    asUser("teacher-2");
    const res = await getAsset(body.asset.id);
    expect(res.status).toBe(403);
  });

  test("404 for unknown id", async () => {
    asUser("teacher-1");
    const res = await getAsset("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  test("400 for malformed id", async () => {
    asUser("teacher-1");
    const res = await getAsset("not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/assets/[id]", () => {
  test("204 removes the row and the bytes; subsequent GET → 404", async () => {
    asUser("teacher-1");
    const created = await postUpload(PNG_1X1);
    const id = ((await created.json()) as { asset: { id: string } }).asset.id;
    const del = await deleteAsset(id);
    expect(del.status).toBe(204);
    const getRes = await getAsset(id);
    expect(getRes.status).toBe(404);
  });

  test("403 cross-tenant", async () => {
    asUser("teacher-1");
    const created = await postUpload(PNG_1X1);
    const id = ((await created.json()) as { asset: { id: string } }).asset.id;
    asUser("teacher-2");
    const res = await deleteAsset(id);
    expect(res.status).toBe(403);
  });
});
