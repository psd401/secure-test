import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { student_accommodations } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `student-accommodations-api tests require the test DB DATABASE_URL; got: ${url}`,
    );
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
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

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

async function createStudent(ssid: string): Promise<string> {
  const { POST } = await import("../app/api/students/route");
  const res = await POST(
    new Request("http://localhost/api/students", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssid }),
    }),
  );
  return ((await res.json()) as { student: { id: string } }).student.id;
}

async function createManualAcc(
  studentId: string,
  body: { subject: string; tool_id: string; value: string },
) {
  const { POST } = await import(
    "../app/api/students/[id]/accommodations/route"
  );
  return POST(
    new Request(`http://localhost/api/students/${studentId}/accommodations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: studentId }) },
  );
}

async function patchAcc(
  studentId: string,
  accId: string,
  body: { value: string },
) {
  const { PATCH } = await import(
    "../app/api/students/[id]/accommodations/[accId]/route"
  );
  return PATCH(
    new Request(
      `http://localhost/api/students/${studentId}/accommodations/${accId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id: studentId, accId }) },
  );
}

async function deleteAcc(studentId: string, accId: string) {
  const { DELETE } = await import(
    "../app/api/students/[id]/accommodations/[accId]/route"
  );
  return DELETE(
    new Request(
      `http://localhost/api/students/${studentId}/accommodations/${accId}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: studentId, accId }) },
  );
}

describe("POST /api/students/[id]/accommodations (manual create)", () => {
  test("creates a manual row with server-forced source", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const res = await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "highlighter",
      value: "On",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      accommodation: { source: string; value: string };
    };
    expect(body.accommodation.source).toBe("manual");
    expect(body.accommodation.value).toBe("On");
  });

  test("rejects unknown tool_id", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const res = await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "totally_not_a_tool",
      value: "On",
    });
    expect(res.status).toBe(400);
  });

  test("rejects unknown subject", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const res = await createManualAcc(sid, {
      subject: "Phys-Ed",
      tool_id: "highlighter",
      value: "On",
    });
    expect(res.status).toBe(400);
  });

  test("409 when a live row already exists for the (subject, tool)", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "highlighter",
      value: "On",
    });
    const dup = await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "highlighter",
      value: "Off",
    });
    expect(dup.status).toBe(409);
  });

  test("403 when student belongs to another teacher", async () => {
    asUser("teacher-A");
    const sid = await createStudent("T001");
    asUser("teacher-B");
    const res = await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "highlighter",
      value: "On",
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/students/[id]/accommodations/[accId] (edit value)", () => {
  test("editing a manual row keeps source=manual, sets edited_at", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const c = await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "highlighter",
      value: "On",
    });
    const aid = ((await c.json()) as { accommodation: { id: string } })
      .accommodation.id;
    const res = await patchAcc(sid, aid, { value: "Off" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accommodation: { source: string; value: string; edited_at: string | null };
    };
    expect(body.accommodation.source).toBe("manual");
    expect(body.accommodation.value).toBe("Off");
    expect(body.accommodation.edited_at).not.toBeNull();
  });

  test("editing a tide_import row transitions source to tide_then_edited", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    // Direct DB insert to simulate a row that came from TIDE import.
    const db = getDb();
    const [inserted] = await db
      .insert(student_accommodations)
      .values({
        student_id: sid,
        subject: "Mathematics",
        tool_id: "color_contrast",
        value: "Black on Rose",
        source: "tide_import",
        tide_code: "TDS_CCMagenta",
        last_imported_at: new Date(),
      })
      .returning();

    const res = await patchAcc(sid, inserted!.id, { value: "Yellow on Black" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accommodation: { source: string; value: string; edited_at: string | null };
    };
    expect(body.accommodation.source).toBe("tide_then_edited");
    expect(body.accommodation.value).toBe("Yellow on Black");
    expect(body.accommodation.edited_at).not.toBeNull();
  });

  test("no-op edit (same value) does not flip source or bump edited_at", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const db = getDb();
    const [inserted] = await db
      .insert(student_accommodations)
      .values({
        student_id: sid,
        subject: "Mathematics",
        tool_id: "color_contrast",
        value: "Black on Rose",
        source: "tide_import",
        last_imported_at: new Date(),
      })
      .returning();
    const res = await patchAcc(sid, inserted!.id, { value: "Black on Rose" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accommodation: { source: string; edited_at: string | null };
    };
    expect(body.accommodation.source).toBe("tide_import");
    expect(body.accommodation.edited_at).toBeNull();
  });

  test("editing a tide_then_edited row keeps source, bumps edited_at", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const db = getDb();
    const earlier = new Date(Date.now() - 60_000);
    const [inserted] = await db
      .insert(student_accommodations)
      .values({
        student_id: sid,
        subject: "Mathematics",
        tool_id: "color_contrast",
        value: "Yellow on Black",
        source: "tide_then_edited",
        edited_at: earlier,
      })
      .returning();
    const res = await patchAcc(sid, inserted!.id, { value: "Red on White" });
    const body = (await res.json()) as {
      accommodation: { source: string; edited_at: string };
    };
    expect(body.accommodation.source).toBe("tide_then_edited");
    expect(new Date(body.accommodation.edited_at).getTime()).toBeGreaterThan(
      earlier.getTime(),
    );
  });
});

describe("DELETE /api/students/[id]/accommodations/[accId]", () => {
  test("manual row → 204 + hard delete", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const c = await createManualAcc(sid, {
      subject: "Mathematics",
      tool_id: "highlighter",
      value: "On",
    });
    const aid = ((await c.json()) as { accommodation: { id: string } })
      .accommodation.id;
    const res = await deleteAcc(sid, aid);
    expect(res.status).toBe(204);
  });

  test("tide_import row → 409 (not deletable, must come via re-import)", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const db = getDb();
    const [inserted] = await db
      .insert(student_accommodations)
      .values({
        student_id: sid,
        subject: "Mathematics",
        tool_id: "color_contrast",
        value: "Black on Rose",
        source: "tide_import",
      })
      .returning();
    const res = await deleteAcc(sid, inserted!.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tide_row_not_deletable");
  });

  test("tide_then_edited row → 409 too", async () => {
    asUser("teacher-1");
    const sid = await createStudent("T001");
    const db = getDb();
    const [inserted] = await db
      .insert(student_accommodations)
      .values({
        student_id: sid,
        subject: "Mathematics",
        tool_id: "color_contrast",
        value: "Yellow on Black",
        source: "tide_then_edited",
        edited_at: new Date(),
      })
      .returning();
    const res = await deleteAcc(sid, inserted!.id);
    expect(res.status).toBe(409);
  });
});
