// R0.2 (docs/reporting-design.md, finding F-1): a teacher could not see a
// saved drawing because nothing under app/ read response_uploads back. These
// tests cover GET /api/responses/[responseId]/upload — the route that fixes
// it — following the same in-process mock harness as review-queue.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  response_uploads,
  responses,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { localFsProvider } from "../lib/storage/localFsProvider";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `response-upload-view tests require the test DB DATABASE_URL; got: ${url}`,
    );
  }
};

let mockSub: string | null = null;
let originalSessionSecret: string | undefined;
let originalRoot: string | undefined;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => (mockSub ? { sub: mockSub, role: "staff" } : null),
}));

const OWNER = "upload-view-teacher";
const OTHER_OWNER = "upload-view-other-teacher";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  originalRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = "./storage-test";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  if (originalRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalRoot;
});

async function seedDrawingResponse(opts: { uploadStatus: "pending" | "complete" }) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Drawing" })
    .returning();
  const [item] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 0,
      type: "drawing_upload",
      stem: "Sketch it",
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "999", name: "Drawing Student" })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      status: "submitted",
      submitted_at: new Date(),
    })
    .returning();

  const storageKey = `responses/${attempt!.id}/${item!.id}/test-object`;
  if (opts.uploadStatus === "complete") {
    await localFsProvider.put({
      id: storageKey,
      bytes: PNG_BYTES,
      content_type: "image/png",
    });
  }
  const [upload] = await db
    .insert(response_uploads)
    .values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      storage_provider: "local-fs",
      storage_key: storageKey,
      content_type: "image/png",
      status: opts.uploadStatus,
    })
    .returning();

  const [response] = await db
    .insert(responses)
    .values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      response: { type: "drawing_upload", upload_id: upload!.id },
    })
    .returning();

  return { assessment: assessment!, item: item!, attempt: attempt!, upload: upload!, response: response! };
}

async function getUpload(responseId: string) {
  const { GET } = await import("../app/api/responses/[responseId]/upload/route");
  return GET(new Request(`http://localhost/api/responses/${responseId}/upload`), {
    params: Promise.resolve({ responseId }),
  });
}

describe("GET /api/responses/[responseId]/upload", () => {
  test("the owning teacher gets the stored bytes back", async () => {
    const s = await seedDrawingResponse({ uploadStatus: "complete" });
    mockSub = OWNER;

    const res = await getUpload(s.response.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PNG_BYTES);
  });

  test("a different teacher gets 404, not 403 — existence is not leaked", async () => {
    const s = await seedDrawingResponse({ uploadStatus: "complete" });
    mockSub = OTHER_OWNER;

    const res = await getUpload(s.response.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  test("a pending (not yet uploaded) slot is 404", async () => {
    const s = await seedDrawingResponse({ uploadStatus: "pending" });
    mockSub = OWNER;

    const res = await getUpload(s.response.id);
    expect(res.status).toBe(404);
  });

  test("an unknown response id is 404", async () => {
    mockSub = OWNER;
    const res = await getUpload("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});
