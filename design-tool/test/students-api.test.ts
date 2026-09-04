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
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `students-api tests require the test DB DATABASE_URL; got: ${url}`,
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

async function listStudents() {
  const { GET } = await import("../app/api/students/route");
  return GET();
}

async function createStudent(body: unknown) {
  const { POST } = await import("../app/api/students/route");
  return POST(
    new Request("http://localhost/api/students", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function getStudent(id: string) {
  const { GET } = await import("../app/api/students/[id]/route");
  return GET(new Request(`http://localhost/api/students/${id}`), {
    params: Promise.resolve({ id }),
  });
}

async function patchStudent(id: string, body: unknown) {
  const { PATCH } = await import("../app/api/students/[id]/route");
  return PATCH(
    new Request(`http://localhost/api/students/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function deleteStudent(id: string) {
  const { DELETE } = await import("../app/api/students/[id]/route");
  return DELETE(new Request(`http://localhost/api/students/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("POST /api/students", () => {
  test("requires a session", async () => {
    asUser(null);
    const res = await createStudent({ ssid: "T001" });
    expect(res.status).toBe(401);
  });

  test("creates a row owned by the session sub", async () => {
    asUser("teacher-1");
    const res = await createStudent({
      ssid: "T001",
      name: "Alex Smith",
      grade: "10",
      school: "PHS",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      student: { id: string; ssid: string; owner_sub: string; school: string };
    };
    expect(body.student.ssid).toBe("T001");
    expect(body.student.owner_sub).toBe("teacher-1");
    expect(body.student.school).toBe("PHS");
  });

  test("rejects duplicate ssid for the same teacher", async () => {
    asUser("teacher-1");
    await createStudent({ ssid: "T001" });
    const res = await createStudent({ ssid: "T001" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ssid_already_exists");
  });

  test("allows the same ssid across different teachers", async () => {
    asUser("teacher-A");
    expect((await createStudent({ ssid: "X" })).status).toBe(201);
    asUser("teacher-B");
    expect((await createStudent({ ssid: "X" })).status).toBe(201);
  });

  test("rejects an empty ssid", async () => {
    asUser("teacher-1");
    const res = await createStudent({ ssid: "" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/students (list)", () => {
  test("returns only the session sub's roster", async () => {
    asUser("teacher-A");
    await createStudent({ ssid: "A1" });
    await createStudent({ ssid: "A2" });
    asUser("teacher-B");
    await createStudent({ ssid: "B1" });

    asUser("teacher-A");
    const res = await listStudents();
    const body = (await res.json()) as {
      students: { ssid: string }[];
    };
    expect(body.students.map((s) => s.ssid).sort()).toEqual(["A1", "A2"]);
  });

  test("accommodation_count counts only live rows", async () => {
    asUser("teacher-1");
    const res = await createStudent({ ssid: "T001" });
    const id = ((await res.json()) as { student: { id: string } }).student.id;

    // Add a manual accommodation
    const { POST } = await import(
      "../app/api/students/[id]/accommodations/route"
    );
    const created = await POST(
      new Request(`http://localhost/api/students/${id}/accommodations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "Mathematics",
          tool_id: "highlighter",
          value: "On",
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(created.status).toBe(201);

    const list = await listStudents();
    const body = (await list.json()) as {
      students: { ssid: string; accommodation_count: number }[];
    };
    expect(body.students[0]!.accommodation_count).toBe(1);
  });
});

describe("GET /api/students/[id]", () => {
  test("returns the student + non-removed accommodations", async () => {
    asUser("teacher-1");
    const c = await createStudent({ ssid: "T001" });
    const id = ((await c.json()) as { student: { id: string } }).student.id;
    const res = await getStudent(id);
    const body = (await res.json()) as {
      student: { ssid: string };
      accommodations: unknown[];
    };
    expect(body.student.ssid).toBe("T001");
    expect(body.accommodations).toEqual([]);
  });

  test("404 for an unknown student", async () => {
    asUser("teacher-1");
    const res = await getStudent("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  test("403 for another teacher's student", async () => {
    asUser("teacher-A");
    const c = await createStudent({ ssid: "X" });
    const id = ((await c.json()) as { student: { id: string } }).student.id;
    asUser("teacher-B");
    const res = await getStudent(id);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/students/[id]", () => {
  test("updates roster metadata", async () => {
    asUser("teacher-1");
    const c = await createStudent({ ssid: "T001" });
    const id = ((await c.json()) as { student: { id: string } }).student.id;
    const patch = await patchStudent(id, { name: "Renamed", grade: "11" });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      student: { name: string; grade: string };
    };
    expect(body.student.name).toBe("Renamed");
    expect(body.student.grade).toBe("11");
  });
});

describe("DELETE /api/students/[id]", () => {
  test("removes the row + cascades accommodations", async () => {
    asUser("teacher-1");
    const c = await createStudent({ ssid: "T001" });
    const id = ((await c.json()) as { student: { id: string } }).student.id;
    const { POST } = await import(
      "../app/api/students/[id]/accommodations/route"
    );
    await POST(
      new Request(`http://localhost/api/students/${id}/accommodations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "Mathematics",
          tool_id: "highlighter",
          value: "On",
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
    const del = await deleteStudent(id);
    expect(del.status).toBe(204);
    const after = await getStudent(id);
    expect(after.status).toBe(404);
  });
});
