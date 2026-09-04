// Slice 65: student file uploads for drawing_upload items.
//
// The response references an upload SLOT the server minted, never a key the
// client chose. These tests lean on that: the cases that matter are a student
// referencing a slot that is not theirs, one that never received bytes, and one
// minted for a different item.
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
import {
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  OTHER_TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  studentPrincipal,
} from "./helpers/roster";
import { isAllowedUploadType, UPLOAD_MAX_BYTES } from "../lib/api/responseUploads";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`response-uploads tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "upload-teacher";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
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

const asStudent = (email: string = STUDENT.email) => {
  principal = studentPrincipal(email);
};

let originalRoot: string | undefined;
let originalSecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = "./storage-test";
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "upload-test-secret";
});

afterEach(async () => {
  principal = null;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalRoot;
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

async function scenario() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: TEACHER, name: "Uploads" })
    .returning();
  const [drawing] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "drawing_upload",
      stem: "Sketch it",
    })
    .returning();
  const [essay] = await db
    .insert(items)
    .values({ assessment_id: assessment!.id, position: 2, type: "essay", stem: "Write" })
    .returning();
  const [student] = await db
    .insert(students)
    .values({
      owner_sub: TEACHER,
      ssid: STUDENT.ssid,
      roster_ps_id: STUDENT.ps_id,
      name: STUDENT.name,
    })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({ assessment_id: assessment!.id, student_id: student!.id, status: "in_progress" })
    .returning();
  return {
    assessment: assessment!,
    drawing: drawing!,
    essay: essay!,
    student: student!,
    attempt: attempt!,
  };
}

async function requestUrl(
  attemptId: string,
  itemId: string,
  contentType = "image/png",
  contentLength = PNG.byteLength,
) {
  const { POST } = await import(
    "../app/api/attempts/[attemptId]/responses/[itemId]/upload-url/route"
  );
  return POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_type: contentType, content_length: contentLength }),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function uploadBytes(
  attemptId: string,
  itemId: string,
  uploadId: string,
  bytes: Uint8Array,
) {
  const { PUT } = await import(
    "../app/api/attempts/[attemptId]/responses/[itemId]/upload/route"
  );
  return PUT(
    new Request(`http://localhost/x?upload_id=${uploadId}`, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function del(attemptId: string, itemId: string) {
  const { DELETE } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ attemptId, itemId }),
  });
}

async function putResponse(attemptId: string, itemId: string, response: unknown) {
  const { PUT } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
  return PUT(
    new Request("http://localhost/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

describe("upload content types", () => {
  // The type is signed into the S3 URL and later served back to a teacher, so
  // the allowlist is where "image" stops meaning "any bytes the client
  // labelled".
  test("allows what a student can plausibly hand in, and nothing else", () => {
    for (const type of ["image/png", "image/jpeg", "image/heic", "application/pdf"]) {
      expect(isAllowedUploadType(type)).toBe(true);
    }
    for (const type of ["text/html", "image/svg+xml", "application/javascript", ""]) {
      expect(isAllowedUploadType(type)).toBe(false);
    }
  });
});

describe("POST .../upload-url", () => {
  test("registers a pending slot and returns somewhere to put the bytes", async () => {
    const s = await scenario();
    asStudent();
    const res = await requestUrl(s.attempt.id, s.drawing.id);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.upload_id).toBeTruthy();
    expect(body.upload.url).toContain(body.upload_id);
    expect(body.max_bytes).toBe(UPLOAD_MAX_BYTES);

    const [row] = await getDb().select().from(response_uploads);
    expect(row?.status).toBe("pending");
    expect(row?.attempt_id).toBe(s.attempt.id);
    expect(row?.item_id).toBe(s.drawing.id);
  });

  // Security review, vuln 1. A presigned PUT can bind an exact Content-Length
  // but not a maximum, so the cap has to be applied BEFORE a URL exists — once
  // it is handed out the upload never passes through this app again.
  test("refuses an oversized declaration before any URL is issued", async () => {
    const s = await scenario();
    asStudent();
    const res = await requestUrl(s.attempt.id, s.drawing.id, "image/png", UPLOAD_MAX_BYTES + 1);
    expect(res.status).toBe(400);
    expect((await getDb().select().from(response_uploads)).length).toBe(0);
  });

  test("refuses a nonsensical declared size", async () => {
    const s = await scenario();
    asStudent();
    for (const size of [0, -1, 1.5]) {
      const res = await requestUrl(s.attempt.id, s.drawing.id, "image/png", size);
      expect(res.status).toBe(400);
    }
    expect((await getDb().select().from(response_uploads)).length).toBe(0);
  });

  test("the declared size is what gets signed, not the cap", async () => {
    // Signing the cap would demand the client send exactly 20 MiB, so no real
    // upload could ever complete.
    const s = await scenario();
    asStudent();
    const body = await (await requestUrl(s.attempt.id, s.drawing.id)).json();
    expect(body.upload.headers["content-length"]).toBe(String(PNG.byteLength));
    expect(body.upload.headers["content-length"]).not.toBe(String(UPLOAD_MAX_BYTES));
  });

  test("refuses a content type outside the allowlist", async () => {
    const s = await scenario();
    asStudent();
    const res = await requestUrl(s.attempt.id, s.drawing.id, "text/html");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_content_type");
    expect((await getDb().select().from(response_uploads)).length).toBe(0);
  });

  test("refuses an item that does not take uploads", async () => {
    const s = await scenario();
    asStudent();
    const res = await requestUrl(s.attempt.id, s.essay.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("item_does_not_take_uploads");
  });

  test("a submitted attempt cannot request new uploads", async () => {
    const s = await scenario();
    await getDb()
      .update(attempts)
      .set({ status: "submitted", submitted_at: new Date() })
      .where(eq(attempts.id, s.attempt.id));
    asStudent();
    expect((await requestUrl(s.attempt.id, s.drawing.id)).status).toBe(409);
  });
});

describe("PUT .../upload — the non-presigned fallback", () => {
  test("stores the bytes and marks the slot complete", async () => {
    const s = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();

    const res = await uploadBytes(s.attempt.id, s.drawing.id, upload_id, PNG);
    expect(res.status).toBe(200);

    const [row] = await getDb().select().from(response_uploads);
    expect(row?.status).toBe("complete");

    const { getStorageProviderById } = await import("../lib/storage/provider");
    const stored = await getStorageProviderById(row!.storage_provider).get(row!.storage_key);
    expect(Array.from(stored)).toEqual(Array.from(PNG));
  });

  test("refuses an empty body", async () => {
    const s = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();
    const res = await uploadBytes(s.attempt.id, s.drawing.id, upload_id, new Uint8Array());
    expect(res.status).toBe(400);
  });

  // Everything the presigned path gets from the signature has to be enforced
  // by hand here, ownership of the slot included.
  test("refuses a slot minted for a different attempt", async () => {
    const mine = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(mine.attempt.id, mine.drawing.id)).json();

    const db = getDb();
    const [otherStudent] = await db
      .insert(students)
      .values({
        owner_sub: TEACHER,
        ssid: OTHER_STUDENT.ssid,
        roster_ps_id: OTHER_STUDENT.ps_id,
        name: OTHER_STUDENT.name,
      })
      .returning();
    const [otherAttempt] = await db
      .insert(attempts)
      .values({
        assessment_id: mine.assessment.id,
        student_id: otherStudent!.id,
        status: "in_progress",
      })
      .returning();

    asStudent(OTHER_STUDENT.email);
    const res = await uploadBytes(otherAttempt!.id, mine.drawing.id, upload_id, PNG);
    expect(res.status).toBe(404);
  });
});

describe("referencing an upload from a response", () => {
  test("a completed upload can be handed in", async () => {
    const s = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();
    await uploadBytes(s.attempt.id, s.drawing.id, upload_id, PNG);

    const res = await putResponse(s.attempt.id, s.drawing.id, {
      type: "drawing_upload",
      upload_id,
    });
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(responses);
    expect(row!.response).toEqual({ type: "drawing_upload", upload_id });
  });

  // Otherwise a student could hand in an id for an upload that never happened
  // and have it look like an answer.
  test("a slot with no bytes yet cannot be handed in", async () => {
    const s = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();

    const res = await putResponse(s.attempt.id, s.drawing.id, {
      type: "drawing_upload",
      upload_id,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("upload_incomplete");
    expect((await getDb().select().from(responses)).length).toBe(0);
  });

  // Finding 10.10 (2026-08-29): on the presigned path the bytes go straight to
  // the backend and this app never sees them land, so the slot sat `pending`
  // forever and every drawing on S3 was refused as upload_incomplete — the
  // student read "Saved." and the answer was lost. The server now asks the
  // provider before calling the slot incomplete. Simulated here by writing
  // the bytes to the slot's key directly, as a direct upload would.
  test("a direct upload the app never saw is settled by asking the provider", async () => {
    const s = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();
    const [slot] = await getDb().select().from(response_uploads).where(eq(response_uploads.id, upload_id));
    expect(slot!.status).toBe("pending");
    const { getStorageProviderById } = await import("../lib/storage/provider");
    await getStorageProviderById(slot!.storage_provider).put({
      id: slot!.storage_key,
      bytes: PNG,
      content_type: "image/png",
    });

    const res = await putResponse(s.attempt.id, s.drawing.id, {
      type: "drawing_upload",
      upload_id,
    });
    expect(res.status).toBe(200);
    const [settled] = await getDb().select().from(response_uploads).where(eq(response_uploads.id, upload_id));
    expect(settled!.status).toBe("complete");
    const [row] = await getDb().select().from(responses);
    expect(row!.response).toEqual({ type: "drawing_upload", upload_id });
  });

  test("an upload id from another student's attempt is refused", async () => {
    const s = await scenario();
    asStudent();
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();
    await uploadBytes(s.attempt.id, s.drawing.id, upload_id, PNG);

    const db = getDb();
    const [otherStudent] = await db
      .insert(students)
      .values({
        owner_sub: TEACHER,
        ssid: OTHER_STUDENT.ssid,
        roster_ps_id: OTHER_STUDENT.ps_id,
        name: OTHER_STUDENT.name,
      })
      .returning();
    const [otherAttempt] = await db
      .insert(attempts)
      .values({
        assessment_id: s.assessment.id,
        student_id: otherStudent!.id,
        status: "in_progress",
      })
      .returning();

    asStudent(OTHER_STUDENT.email);
    const res = await putResponse(otherAttempt!.id, s.drawing.id, {
      type: "drawing_upload",
      upload_id,
    });
    expect(res.status).toBe(404);
  });

  test("a fabricated upload id is refused", async () => {
    const s = await scenario();
    asStudent();
    const res = await putResponse(s.attempt.id, s.drawing.id, {
      type: "drawing_upload",
      upload_id: "99999999-9999-4999-8999-999999999999",
    });
    expect(res.status).toBe(404);
  });
});

// Slice 73: superseded and withdrawn uploads are reclaimed.
//
// Without this a student who redraws three times left three files in storage
// forever, two referenced by nothing. Not an access-control problem — the bytes
// were always their own — but student work accumulating with no retention
// policy, which is docs/plan.md risk #4. Nothing in the product ever listed it,
// so nobody would have gone looking.
describe("reclaiming superseded uploads", () => {
  async function saveDrawing(s: Awaited<ReturnType<typeof scenario>>) {
    const { upload_id } = await (await requestUrl(s.attempt.id, s.drawing.id)).json();
    await uploadBytes(s.attempt.id, s.drawing.id, upload_id, PNG);
    await putResponse(s.attempt.id, s.drawing.id, { type: "drawing_upload", upload_id });
    return upload_id;
  }

  test("redrawing leaves exactly one upload behind", async () => {
    const s = await scenario();
    asStudent();
    const first = await saveDrawing(s);
    const second = await saveDrawing(s);
    expect(second).not.toBe(first);

    const rows = await getDb().select().from(response_uploads);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(second);
  });

  test("the superseded file is deleted, not just its row", async () => {
    const s = await scenario();
    asStudent();
    await saveDrawing(s);
    const [before] = await getDb().select().from(response_uploads);
    const staleKey = before!.storage_key;
    await saveDrawing(s);

    const { getStorageProviderById } = await import("../lib/storage/provider");
    await expect(
      (async () => {
        await getStorageProviderById("local-fs").get(staleKey);
      })(),
    ).rejects.toThrow();
  });

  // Keeping the bytes for an answer the student explicitly retracted is the
  // version of this nobody would defend if asked.
  test("withdrawing a drawing takes its file with it", async () => {
    const s = await scenario();
    asStudent();
    await saveDrawing(s);
    expect((await getDb().select().from(response_uploads)).length).toBe(1);

    const res = await del(s.attempt.id, s.drawing.id);
    expect(res.status).toBe(204);
    expect((await getDb().select().from(response_uploads)).length).toBe(0);
  });

  test("one student's redraw never touches another's uploads", async () => {
    const mine = await scenario();
    asStudent();
    await saveDrawing(mine);

    const db = getDb();
    const [other] = await db
      .insert(students)
      .values({
        owner_sub: TEACHER,
        ssid: OTHER_STUDENT.ssid,
        roster_ps_id: OTHER_STUDENT.ps_id,
        name: OTHER_STUDENT.name,
      })
      .returning();
    const [otherAttempt] = await db
      .insert(attempts)
      .values({
        assessment_id: mine.assessment.id,
        student_id: other!.id,
        status: "in_progress",
      })
      .returning();

    asStudent(OTHER_STUDENT.email);
    const { upload_id } = await (
      await requestUrl(otherAttempt!.id, mine.drawing.id)
    ).json();
    await uploadBytes(otherAttempt!.id, mine.drawing.id, upload_id, PNG);
    await putResponse(otherAttempt!.id, mine.drawing.id, {
      type: "drawing_upload",
      upload_id,
    });

    // Both students still have exactly one upload each. Pruning is scoped to
    // (attempt, item), so a classmate answering the same item cannot reclaim
    // somebody else's work.
    const rows = await getDb().select().from(response_uploads);
    expect(rows.length).toBe(2);
  });
})
