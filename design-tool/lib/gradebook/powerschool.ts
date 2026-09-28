// PowerTeacher Pro client (docs/gradebook-push-design.md, "PowerSchool
// client"). Two implementations behind one interface, selected by
// GRADEBOOK_PROVIDER — the same default-off shape as NOTIFY_PROVIDER:
//
//   mock (default) — an in-memory gradebook that records every call. Tests,
//                    CI and local dev never reach PowerSchool.
//   live           — the PSD plugin's /ws/xte/ endpoints: an OAuth
//                    client-credentials token, then Bearer on every call.
//
// Every call names the acting teacher's `users_dcid`, and PowerSchool does
// not restrict a plugin by user — the tool is the authorization layer
// (lib/gradebook/authorizeSend.ts). Nothing here takes a users_dcid from a
// request body; callers pass the one authorizeSend resolved.
//
// LOGGING: this module never logs a token, a credential, a request body or a
// response body. Callers log what they need through `lib/log.ts`.
import {
  parseCategories,
  parseCreatedAssignmentSectionId,
  type PsCategory,
} from "./powerschoolPayloads";

/** A non-2xx from PowerSchool, after the retries. */
// Plain fields rather than parameter properties: scripts/ps-send-check.ts
// loads this file under node's type stripping, which refuses those.
export class GradebookHttpError extends Error {
  readonly status: number;
  /** The response body as text, cut to 4 000 characters. */
  readonly body: string;
  readonly stage: "token" | "request";

  constructor(status: number, body: string, stage: "token" | "request") {
    super(`powerschool ${stage} failed with HTTP ${status}`);
    this.name = "GradebookHttpError";
    this.status = status;
    this.body = body;
    this.stage = stage;
  }
}

/** GRADEBOOK_PROVIDER=live without the three POWERSCHOOL_* variables. */
export class GradebookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradebookConfigError";
  }
}

export interface PowerSchoolClient {
  readonly id: "mock" | "live";
  /** Every category the teacher has for that school year (active or not). */
  listCategories(usersDcid: string, yearId: string): Promise<PsCategory[]>;
  /** Creates the assignment; answers its `assignmentsectionid`. */
  createAssignment(
    usersDcid: string,
    body: Record<string, unknown>,
  ): Promise<{ assignmentSectionId: string | null; raw: unknown }>;
  /** Writes scores; answers the parsed 2xx body (or null when empty). */
  writeScores(
    usersDcid: string,
    termId: string,
    body: Record<string, unknown>,
  ): Promise<unknown>;
}

// ── live ─────────────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LiveClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * Injected transport. Production passes nothing and gets the global fetch
   * with normal TLS verification; a dev script may inject a pinned transport
   * for the self-signed test server. Nothing test-shaped lives here.
   */
  fetch?: FetchLike;
  now?: () => number;
}

const BODY_MAX = 4000;

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Only an ERROR body is cut, for the error it rides on. A 2xx body is parsed
// whole: a category list with HTML descriptions runs well past 4 000
// characters, and cutting it first broke the JSON (slice 2c, 2026-09-28).
function cut(text: string): string {
  return text.length <= BODY_MAX ? text : `${text.slice(0, BODY_MAX - 1)}…`;
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Token lifetime margin: a token is renewed 60 s before it would expire. */
export const TOKEN_MARGIN_MS = 60_000;

export function createLivePowerSchoolClient(options: LiveClientOptions): PowerSchoolClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    if (cached && now() < cached.expiresAt) return cached.token;
    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
    const res = await doFetch(`${base}/oauth/access_token/`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const text = await readText(res);
    if (!res.ok) throw new GradebookHttpError(res.status, cut(text), "token");
    const json = parseJson(text) as { access_token?: unknown; expires_in?: unknown } | null;
    const access = typeof json?.access_token === "string" ? json.access_token : null;
    if (!access) throw new GradebookHttpError(res.status, "token response had no access_token", "token");
    // PowerSchool has been seen to send expires_in as a string.
    const seconds = Number(json?.expires_in);
    const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    cached = { token: access, expiresAt: now() + lifetimeMs - TOKEN_MARGIN_MS };
    return access;
  }

  async function call(
    method: "GET" | "POST" | "PUT",
    path: string,
    query: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown; location: string | null }> {
    const url = `${base}${path}?${new URLSearchParams(query).toString()}`;
    let retried401 = false;
    let retried412 = false;
    for (;;) {
      const res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await token()}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 401 && !retried401) {
        // A token revoked or expired early: drop it and ask once more.
        retried401 = true;
        cached = null;
        await readText(res);
        continue;
      }
      if (res.status === 412 && !retried412) {
        // PowerTeacher Pro's "Resubmit": the same request, once.
        retried412 = true;
        await readText(res);
        continue;
      }
      const text = await readText(res);
      if (!res.ok) throw new GradebookHttpError(res.status, cut(text), "request");
      return { status: res.status, json: parseJson(text), location: res.headers.get("location") };
    }
  }

  return {
    id: "live",
    async listCategories(usersDcid, yearId) {
      const { json } = await call("GET", "/ws/xte/teacher_category", {
        users_dcid: usersDcid,
        year_id: yearId,
      });
      return parseCategories(json);
    },
    async createAssignment(usersDcid, body) {
      const { json, location } = await call(
        "POST",
        "/ws/xte/section/assignment/",
        { users_dcid: usersDcid },
        body,
      );
      return { assignmentSectionId: parseCreatedAssignmentSectionId(json, location), raw: json };
    },
    async writeScores(usersDcid, termId, body) {
      const { json } = await call(
        "PUT",
        "/ws/xte/score",
        { users_dcid: usersDcid, status: "A", term_id: termId },
        body,
      );
      return json;
    },
  };
}

// ── mock ─────────────────────────────────────────────────────────────────────

export interface MockCall {
  method: "listCategories" | "createAssignment" | "writeScores";
  usersDcid: string;
  yearId?: string;
  termId?: string;
  body?: Record<string, unknown>;
}

/**
 * The in-memory gradebook. Assignments and scores persist for the process so a
 * re-send can be asserted against; `reset()` clears everything between tests.
 */
export class MockPowerSchool implements PowerSchoolClient {
  readonly id = "mock" as const;
  readonly calls: MockCall[] = [];
  private categories = new Map<string, PsCategory[]>();
  private failures: Array<{ method: MockCall["method"]; status: number; body: string }> = [];
  private nextAssignment = 70001;
  private nextScore = 90001;
  /** assignmentsectionid → the create body. */
  readonly assignments = new Map<string, Record<string, unknown>>();
  /** `${assignmentsectionid}:${studentsdcid}` → the stored score. */
  readonly scores = new Map<string, { assignmentscoreid: string; points: number }>();

  reset(): void {
    this.calls.length = 0;
    this.categories.clear();
    this.failures = [];
    this.assignments.clear();
    this.scores.clear();
  }

  /** Categories for one teacher; a teacher never set gets `defaultMockCategories()`. */
  setCategories(usersDcid: string, list: PsCategory[]): void {
    this.categories.set(usersDcid, list);
  }

  /** The next call of this method throws a GradebookHttpError. */
  failNext(method: MockCall["method"], status: number, body: string): void {
    this.failures.push({ method, status, body });
  }

  /** Forget an assignment, as a teacher deleting it in PTP would. */
  deleteAssignment(assignmentSectionId: string): void {
    this.assignments.delete(assignmentSectionId);
  }

  private maybeFail(method: MockCall["method"]): void {
    const i = this.failures.findIndex((f) => f.method === method);
    if (i < 0) return;
    const [f] = this.failures.splice(i, 1);
    throw new GradebookHttpError(f!.status, f!.body, "request");
  }

  async listCategories(usersDcid: string, yearId: string): Promise<PsCategory[]> {
    this.calls.push({ method: "listCategories", usersDcid, yearId });
    this.maybeFail("listCategories");
    return (this.categories.get(usersDcid) ?? defaultMockCategories()).map((c) => ({ ...c }));
  }

  async createAssignment(usersDcid: string, body: Record<string, unknown>) {
    this.calls.push({ method: "createAssignment", usersDcid, body });
    this.maybeFail("createAssignment");
    const id = String(this.nextAssignment++);
    this.assignments.set(id, body);
    // Echo the assignment the way the create is expected to (see
    // parseCreatedAssignmentSectionId): the first section carries the id.
    const sections = (body._assignmentsections as Record<string, unknown>[] | undefined) ?? [];
    const raw = {
      _name: "assignment",
      assignmentid: Number(id) - 50000,
      _assignmentsections: sections.map((s) => ({
        ...s,
        _name: "assignmentsection",
        assignmentsectionid: Number(id),
      })),
    };
    return { assignmentSectionId: parseCreatedAssignmentSectionId(raw, null), raw };
  }

  async writeScores(usersDcid: string, termId: string, body: Record<string, unknown>) {
    this.calls.push({ method: "writeScores", usersDcid, termId, body });
    this.maybeFail("writeScores");
    const rows = (body.assignment_scores as Record<string, unknown>[] | undefined) ?? [];
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const asid = String(
        (row._assignmentsection as Record<string, unknown> | undefined)?.assignmentsectionid ?? "",
      );
      if (!this.assignments.has(asid)) {
        throw new GradebookHttpError(404, `{"message":"assignment section not found"}`, "request");
      }
      const key = `${asid}:${String(row.studentsdcid)}`;
      const existing = this.scores.get(key);
      const assignmentscoreid = existing?.assignmentscoreid ?? String(this.nextScore++);
      this.scores.set(key, { assignmentscoreid, points: Number(row.scorepoints) });
      out.push({
        _name: "assignmentscore",
        studentsdcid: row.studentsdcid,
        assignmentscoreid: Number(assignmentscoreid),
      });
    }
    return { assignment_scores: out };
  }
}

/** Synthetic categories for a teacher the mock was not told about. */
export function defaultMockCategories(): PsCategory[] {
  const district = (n: number, name: string): PsCategory => ({
    id: String(600 + n),
    name,
    categorytype: "district",
    districtteachercategoryid: n,
    isactive: true,
    defaultpublishoption: "Immediately",
  });
  return [
    district(1, "Classwork"),
    district(2, "Test"),
    district(3, "Project"),
    district(4, "Quiz"),
    {
      id: "611",
      name: "Labs",
      categorytype: "user",
      districtteachercategoryid: null,
      isactive: true,
      defaultpublishoption: "Immediately",
    },
  ];
}

export const mockPowerSchool = new MockPowerSchool();

// ── selection ────────────────────────────────────────────────────────────────

let liveClient: { key: string; client: PowerSchoolClient } | null = null;

/**
 * The active client. `GRADEBOOK_PROVIDER` unset or "mock" → the shared mock;
 * "live" → the plugin client, built once per process per configuration so the
 * token cache is shared. Throws GradebookConfigError when "live" lacks a
 * variable, or for an unknown provider.
 */
export function getPowerSchoolClient(): PowerSchoolClient {
  const provider = process.env.GRADEBOOK_PROVIDER ?? "mock";
  if (provider === "mock") return mockPowerSchool;
  if (provider !== "live") {
    throw new GradebookConfigError(
      `gradebook provider "${provider}" is not implemented. Supported: "mock", "live".`,
    );
  }
  const baseUrl = process.env.POWERSCHOOL_BASE_URL ?? "";
  const clientId = process.env.POWERSCHOOL_CLIENT_ID ?? "";
  const clientSecret = process.env.POWERSCHOOL_CLIENT_SECRET ?? "";
  if (!baseUrl || !clientId || !clientSecret) {
    throw new GradebookConfigError(
      "GRADEBOOK_PROVIDER=live needs POWERSCHOOL_BASE_URL, POWERSCHOOL_CLIENT_ID and POWERSCHOOL_CLIENT_SECRET.",
    );
  }
  const key = `${baseUrl}\u0000${clientId}\u0000${clientSecret}`;
  if (!liveClient || liveClient.key !== key) {
    liveClient = { key, client: createLivePowerSchoolClient({ baseUrl, clientId, clientSecret }) };
  }
  return liveClient.client;
}
