// Gradebook push slice 2b (docs/gradebook-push-design.md): the PowerTeacher
// Pro payloads, readers, planner and client — no database.
//
// Fixtures are hand-written in the shapes slice 2a read from the test server
// (§Progress "2026-09-28 — slice 2a": plain arrays, `_name` type tags,
// `teachercategoryid`, `YYYY-MM-DD` dates). Every id is synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import {
  GradebookConfigError,
  GradebookHttpError,
  MockPowerSchool,
  createLivePowerSchoolClient,
  getPowerSchoolClient,
  mockPowerSchool,
  type FetchLike,
} from "../lib/gradebook/powerschool";
import {
  activeCategories,
  buildAssignmentCreateBody,
  defaultCategoryId,
  parseCategories,
  parseCreatedAssignmentSectionId,
  truncateAssignmentName,
} from "../lib/gradebook/powerschoolPayloads";
import {
  buildScoreWriteBodyUnconfirmed,
  parseScoreWriteResponseUnconfirmed,
} from "../lib/gradebook/powerschoolScoreBodyUnconfirmed";
import { missingPowerSchoolIds, planSend, type Candidate } from "../lib/gradebook/mapping";
import { maskIdsForLog, todayPacific } from "../lib/gradebook/sendPowerSchool";

// ── A teacher_category response, as 2a read it (ids synthetic) ──────────────

function category(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    _name: "teachercategory",
    teachercategoryid: 1,
    name: "x",
    categorytype: "user",
    isactive: true,
    defaultpublishoption: "Immediately",
    defaultscoreentrypoints: 10,
    defaultweight: 1,
    defaulttotalvalue: 10,
    isdefaultpublishscores: true,
    _teachercategorysectionexcludeassociations: [],
    ...overrides,
  };
}

const CATEGORIES_ALL_DISTRICT_INACTIVE = [
  category({ teachercategoryid: 4101, name: "Classwork", categorytype: "district", districtteachercategoryid: 1, isactive: false }),
  category({ teachercategoryid: 4102, name: "Test", categorytype: "district", districtteachercategoryid: 2, isactive: false }),
  category({ teachercategoryid: 4103, name: "Project", categorytype: "district", districtteachercategoryid: 3, isactive: false }),
  category({ teachercategoryid: 4104, name: "Quiz", categorytype: "district", districtteachercategoryid: 4, isactive: false }),
  category({ teachercategoryid: 4201, name: "Summative", isactive: true }),
  category({ teachercategoryid: 4202, name: "Formative", isactive: true }),
];

const CATEGORIES_TEST_ACTIVE = [
  category({ teachercategoryid: 4301, name: "Classwork", categorytype: "district", districtteachercategoryid: 1 }),
  category({ teachercategoryid: 4302, name: "Test", categorytype: "district", districtteachercategoryid: 2, defaultpublishoption: "OnSpecificDate" }),
  category({ teachercategoryid: 4401, name: "Labs" }),
];

describe("categories (D-6)", () => {
  test("parses the plain array, ids as strings", () => {
    const parsed = parseCategories(CATEGORIES_TEST_ACTIVE);
    expect(parsed.map((c) => c.id)).toEqual(["4301", "4302", "4401"]);
    expect(parsed[1]).toEqual({
      id: "4302",
      name: "Test",
      categorytype: "district",
      districtteachercategoryid: 2,
      isactive: true,
      defaultpublishoption: "OnSpecificDate",
    });
    expect(parseCategories({ not: "an array" })).toEqual([]);
  });

  test("default = the active district Test copy", () => {
    expect(defaultCategoryId(parseCategories(CATEGORIES_TEST_ACTIVE))).toBe("4302");
  });

  test("no default when the Test copy is inactive — no first-active fallback", () => {
    const all = parseCategories(CATEGORIES_ALL_DISTRICT_INACTIVE);
    expect(defaultCategoryId(all)).toBeNull();
    // The dialog still lists the active ones, alphabetically.
    expect(activeCategories(all).map((c) => c.name)).toEqual(["Formative", "Summative"]);
  });
});

describe("assignment create body", () => {
  test("one section, points only, category association primary", () => {
    const body = buildAssignmentCreateBody({
      sectionDcid: "85001",
      name: "Unit 3 test",
      dueDate: "2026-09-28",
      maxPoints: 12,
      categoryId: "4302",
      publishOption: "Immediately",
    });
    expect(body).toEqual({
      _assignmentsections: [
        {
          sectionsdcid: 85001,
          name: "Unit 3 test",
          duedate: "2026-09-28",
          scoretype: "POINTS",
          scoreentrypoints: 12,
          totalpointvalue: 12,
          weight: 1,
          iscountedinfinalgrade: true,
          isscoringneeded: true,
          publishoption: "Immediately",
          _assignmentcategoryassociations: [{ teachercategoryid: 4302, isprimary: true }],
        },
      ],
    });
  });

  test("a category with no publish option omits the field", () => {
    const body = buildAssignmentCreateBody({
      sectionDcid: "85001",
      name: "x",
      dueDate: "2026-09-28",
      maxPoints: 1,
      categoryId: "4302",
      publishOption: null,
    });
    const section = (body._assignmentsections as Record<string, unknown>[])[0]!;
    expect("publishoption" in section).toBe(false);
  });

  test("the name is cut to 50 characters", () => {
    const long = "A".repeat(49) + "BCDEF";
    expect(truncateAssignmentName(long)).toBe("A".repeat(49) + "B");
    expect(truncateAssignmentName("  short  ")).toBe("short");
  });

  test("the created id is read from the echoed section, a top-level field, or Location", () => {
    expect(
      parseCreatedAssignmentSectionId(
        { _name: "assignment", assignmentid: 5, _assignmentsections: [{ _name: "assignmentsection", assignmentsectionid: 77001 }] },
        null,
      ),
    ).toBe("77001");
    expect(parseCreatedAssignmentSectionId({ assignmentsectionid: "77002" }, null)).toBe("77002");
    expect(parseCreatedAssignmentSectionId(null, "https://ps.example.test/ws/xte/section/assignment/77003")).toBe("77003");
    expect(parseCreatedAssignmentSectionId({}, null)).toBeNull();
  });
});

describe("score write body (UNCONFIRMED until 2c)", () => {
  test("IT's documented shape; assignmentscoreid only on an update", () => {
    const body = buildScoreWriteBodyUnconfirmed("77001", [
      { studentDcid: "81001", points: 9.5, externalScoreId: null },
      { studentDcid: "81002", points: 7, externalScoreId: "90001" },
    ]);
    expect(body).toEqual({
      assignment_scores: [
        {
          _assignmentsection: { assignmentsectionid: 77001 },
          studentsdcid: 81001,
          actualscoreentered: "9.5",
          actualscorekind: "REAL_SCORE",
          scoretype: "POINTS",
          scorepoints: 9.5,
        },
        {
          _assignmentsection: { assignmentsectionid: 77001 },
          studentsdcid: 81002,
          actualscoreentered: "7",
          actualscorekind: "REAL_SCORE",
          scoretype: "POINTS",
          scorepoints: 7,
          assignmentscoreid: 90001,
        },
      ],
    });
  });

  test("the response reader keys ids and errors by student DCID", () => {
    const out = parseScoreWriteResponseUnconfirmed({
      assignment_scores: [
        { studentsdcid: 81001, assignmentscoreid: 90001 },
        { studentsdcid: 81002, error: "score exceeds maximum" },
      ],
    });
    expect(out.byStudentDcid.get("81001")).toEqual({ assignmentscoreid: "90001", error: null });
    expect(out.byStudentDcid.get("81002")).toEqual({ assignmentscoreid: null, error: "score exceeds maximum" });
    expect(parseScoreWriteResponseUnconfirmed(null).byStudentDcid.size).toBe(0);
  });
});

// ── The planner (D-3, D-7) ──────────────────────────────────────────────────

function cand(overrides: Partial<Candidate>): Candidate {
  return {
    attempt_id: "a",
    student_number: "1001",
    student_dcid: "81001",
    total_points: 5,
    unscored_count: 0,
    ...overrides,
  };
}

describe("planSend", () => {
  test("holds back unscored, unlinked and DCID-less rows, in that order", () => {
    const plan = planSend(
      [
        cand({ attempt_id: "u", unscored_count: 1, student_dcid: null }),
        cand({ attempt_id: "r", student_number: null, student_dcid: null }),
        cand({ attempt_id: "d", student_dcid: null }),
        cand({ attempt_id: "ok" }),
      ],
      new Map(),
    );
    expect(plan.held_back.map((h) => [h.attempt_id, h.reason])).toEqual([
      ["u", "unscored"],
      ["r", "not_on_roster"],
      ["d", "no_dcid"],
    ]);
    expect(plan.writes.map((w) => [w.attempt_id, w.kind])).toEqual([["ok", "new"]]);
  });

  test("a re-send skips unchanged points and updates changed ones with the stored score id", () => {
    const plan = planSend(
      [cand({ attempt_id: "same", total_points: 5 }), cand({ attempt_id: "changed", total_points: 6 })],
      new Map([
        ["same", { points_sent: 5, external_score_id: "90001" }],
        ["changed", { points_sent: 4, external_score_id: "90002" }],
      ]),
    );
    expect(plan.skipped_unchanged).toEqual(["same"]);
    expect(plan.writes).toEqual([
      {
        attempt_id: "changed",
        student_number: "1001",
        student_dcid: "81001",
        points: 6,
        external_score_id: "90002",
        kind: "update",
      },
    ]);
  });

  test("the section / teacher ids a send needs", () => {
    expect(missingPowerSchoolIds("8301", { ps_id: "5001", dcid: "85001", year_id: "31", term_id: "3100" })).toEqual([]);
    expect(missingPowerSchoolIds(null, { ps_id: "5001", dcid: null, year_id: null, term_id: null })).toEqual([
      "users_dcid",
      "section_dcid",
      "year_id",
      "term_id",
    ]);
  });
});

describe("helpers", () => {
  test("todayPacific is the district's date, not UTC's", () => {
    // 2026-09-29 03:00 UTC is still the 28th in Pacific time.
    expect(todayPacific(new Date("2026-09-29T03:00:00Z"))).toBe("2026-09-28");
    expect(todayPacific(new Date("2026-09-29T08:00:00Z"))).toBe("2026-09-29");
  });

  test("a logged 409 body keeps its words and loses its ids", () => {
    expect(maskIdsForLog('{"studentsdcid":81001,"message":"scorepoints exceeds 12"}')).toBe(
      '{"studentsdcid":#,"message":"scorepoints exceeds 12"}',
    );
  });
});

// ── The live client over an injected fetch ─────────────────────────────────

type Handler = (url: string, init: RequestInit) => Response;

function fakeFetch(handlers: Handler[]): { fetch: FetchLike; seen: Array<{ url: string; init: RequestInit }> } {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  return {
    seen,
    fetch: async (url, init = {}) => {
      seen.push({ url, init });
      const handler = handlers[i++];
      if (!handler) throw new Error(`unexpected call ${i}: ${url}`);
      return handler(url, init);
    },
  };
}

const tokenOk = (expires = 3600) => () =>
  new Response(JSON.stringify({ access_token: `tok-${expires}`, token_type: "Bearer", expires_in: String(expires) }), {
    status: 200,
  });
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

describe("live client", () => {
  const BASE = "https://ps.example.test/";

  test("client-credentials token (Basic), then Bearer; token cached until expires_in − 60 s", async () => {
    let clock = 1_000_000;
    const { fetch, seen } = fakeFetch([
      tokenOk(120),
      json(200, CATEGORIES_TEST_ACTIVE),
      json(200, CATEGORIES_TEST_ACTIVE),
      tokenOk(120),
      json(200, []),
    ]);
    const client = createLivePowerSchoolClient({
      baseUrl: BASE,
      clientId: "id",
      clientSecret: "secret",
      fetch,
      now: () => clock,
    });
    const cats = await client.listCategories("8301", "31");
    expect(cats.map((c) => c.id)).toEqual(["4301", "4302", "4401"]);

    expect(seen[0]!.url).toBe("https://ps.example.test/oauth/access_token/");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`,
    );
    expect(seen[0]!.init.body).toBe("grant_type=client_credentials");
    expect(seen[1]!.url).toBe("https://ps.example.test/ws/xte/teacher_category?users_dcid=8301&year_id=31");
    expect((seen[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-120");

    // 59 s later: still cached (120 − 60 = 60 s of life).
    clock += 59_000;
    await client.listCategories("8301", "31");
    expect(seen.length).toBe(3);
    // 61 s: renewed.
    clock += 2_000;
    await client.listCategories("8301", "31");
    expect(seen[3]!.url).toContain("/oauth/access_token/");
  });

  test("one retry on 401 with a fresh token; a second 401 surfaces", async () => {
    const { fetch, seen } = fakeFetch([
      tokenOk(),
      json(401, { message: "expired" }),
      tokenOk(),
      json(200, []),
    ]);
    const client = createLivePowerSchoolClient({ baseUrl: BASE, clientId: "i", clientSecret: "s", fetch });
    expect(await client.listCategories("8301", "31")).toEqual([]);
    expect(seen.map((s) => s.url.includes("access_token"))).toEqual([true, false, true, false]);

    const twice = fakeFetch([tokenOk(), json(401, {}), tokenOk(), json(401, { m: "no" })]);
    const again = createLivePowerSchoolClient({ baseUrl: BASE, clientId: "i", clientSecret: "s", fetch: twice.fetch });
    const err = await again.listCategories("8301", "31").catch((e) => e);
    expect(err).toBeInstanceOf(GradebookHttpError);
    expect(err.status).toBe(401);
  });

  test("one retry on 412 (Resubmit), same request", async () => {
    const { fetch, seen } = fakeFetch([
      tokenOk(),
      json(412, { message: "Resubmit" }),
      json(200, { assignment_scores: [] }),
    ]);
    const client = createLivePowerSchoolClient({ baseUrl: BASE, clientId: "i", clientSecret: "s", fetch });
    await client.writeScores("8301", "3100", { assignment_scores: [] });
    expect(seen[1]!.url).toBe(seen[2]!.url);
    expect(seen[2]!.url).toBe("https://ps.example.test/ws/xte/score?users_dcid=8301&status=A&term_id=3100");
    expect(seen[2]!.init.method).toBe("PUT");
  });

  test("a 409 body surfaces verbatim on the error", async () => {
    const body = '{"message":"Validation failed","errors":[{"field":"duedate"}]}';
    const { fetch } = fakeFetch([tokenOk(), () => new Response(body, { status: 409 })]);
    const client = createLivePowerSchoolClient({ baseUrl: BASE, clientId: "i", clientSecret: "s", fetch });
    const err = await client.createAssignment("8301", {}).catch((e) => e);
    expect(err).toBeInstanceOf(GradebookHttpError);
    expect(err.status).toBe(409);
    expect(err.body).toBe(body);
  });

  test("create reads the assignmentsectionid off the 201", async () => {
    const { fetch, seen } = fakeFetch([
      tokenOk(),
      json(201, { _name: "assignment", _assignmentsections: [{ assignmentsectionid: 77009 }] }),
    ]);
    const client = createLivePowerSchoolClient({ baseUrl: BASE, clientId: "i", clientSecret: "s", fetch });
    const created = await client.createAssignment("8301", { _assignmentsections: [] });
    expect(created.assignmentSectionId).toBe("77009");
    expect(seen[1]!.url).toBe("https://ps.example.test/ws/xte/section/assignment/?users_dcid=8301");
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ _assignmentsections: [] });
  });
});

describe("the mock gradebook", () => {
  afterEach(() => {
    mockPowerSchool.reset();
    delete process.env.GRADEBOOK_PROVIDER;
  });

  test("records calls, creates, writes and updates scores", async () => {
    const mock = new MockPowerSchool();
    const created = await mock.createAssignment("8301", buildAssignmentCreateBody({
      sectionDcid: "85001",
      name: "x",
      dueDate: "2026-09-28",
      maxPoints: 2,
      categoryId: "602",
      publishOption: null,
    }));
    const asid = created.assignmentSectionId!;
    const first = parseScoreWriteResponseUnconfirmed(
      await mock.writeScores("8301", "3100", buildScoreWriteBodyUnconfirmed(asid, [
        { studentDcid: "81001", points: 2, externalScoreId: null },
      ])),
    );
    const scoreId = first.byStudentDcid.get("81001")!.assignmentscoreid;
    await mock.writeScores("8301", "3100", buildScoreWriteBodyUnconfirmed(asid, [
      { studentDcid: "81001", points: 1, externalScoreId: scoreId },
    ]));
    expect(mock.scores.get(`${asid}:81001`)).toEqual({ assignmentscoreid: scoreId!, points: 1 });
    expect(mock.calls.map((c) => c.method)).toEqual(["createAssignment", "writeScores", "writeScores"]);

    mock.failNext("writeScores", 409, "nope");
    const err = await mock.writeScores("8301", "3100", {}).catch((e) => e);
    expect(err.status).toBe(409);
  });

  test("provider selection: mock by default; live needs its three variables", () => {
    expect(getPowerSchoolClient()).toBe(mockPowerSchool);
    process.env.GRADEBOOK_PROVIDER = "live";
    const saved = {
      base: process.env.POWERSCHOOL_BASE_URL,
      id: process.env.POWERSCHOOL_CLIENT_ID,
      secret: process.env.POWERSCHOOL_CLIENT_SECRET,
    };
    delete process.env.POWERSCHOOL_BASE_URL;
    expect(() => getPowerSchoolClient()).toThrow(GradebookConfigError);
    process.env.POWERSCHOOL_BASE_URL = "https://ps.example.test";
    process.env.POWERSCHOOL_CLIENT_ID = "i";
    process.env.POWERSCHOOL_CLIENT_SECRET = "s";
    expect(getPowerSchoolClient().id).toBe("live");
    process.env.GRADEBOOK_PROVIDER = "carrier-pigeon";
    expect(() => getPowerSchoolClient()).toThrow(GradebookConfigError);
    for (const [k, v] of [
      ["POWERSCHOOL_BASE_URL", saved.base],
      ["POWERSCHOOL_CLIENT_ID", saved.id],
      ["POWERSCHOOL_CLIENT_SECRET", saved.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
