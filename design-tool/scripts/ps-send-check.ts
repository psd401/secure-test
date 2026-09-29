// Slice 2c live check of the PowerSchool send (docs/gradebook-push-design.md)
// against the PowerSchool TEST server, through the app's own client code
// (lib/gradebook/powerschool.ts, powerschoolPayloads.ts,
// powerschoolScoreBodyUnconfirmed.ts) — so what is confirmed here is what
// ships.
//
//   ~/ps-env.sh run node scripts/ps-send-check.ts <teacher-email> --section <dcid> \
//     [--category <teachercategoryid>] [--students 3] [--due YYYY-MM-DD] \
//     [--write] [--out <file>]
//   ~/ps-env.sh run node scripts/ps-send-check.ts <teacher-email> --cleanup <assignmentid>
//
// Without --write it is read-only: it resolves the teacher, section, term,
// students and category, and prints the create and score bodies with ids
// masked. With --write it runs the three steps the note's Verification asks
// for: create one assignment, write synthetic scores for a few enrolled
// students, then re-send one corrected score; after each write it reads back
// (the assignment by GET, the scores from the ASSIGNMENTSCORE table) and
// prints response SHAPES, so the "Unconfirmed" score file can be settled.
// --cleanup deletes a check assignment (force=true removes its scores).
//
// The test server holds a June 2025 copy of production; the section must be
// a 2024-25 one (the production section page's frn=003<dcid> works). The
// scores are synthetic and go to a TEST server only — IT confirmed writes
// there (2026-09-28).
//
// Transport: node, not bun (the test server's self-signed certificate lacks
// the CA flag; Node's OpenSSL accepts it as the trust anchor, Bun's TLS
// refuses it). Connects to PS_CONNECT_IP, verifies the certificate against
// the hostname in PS_BASE_URL trusting only PS_CA_FILE, and refuses to run
// unless a wrong server name is rejected — same rules as ps-probe.ts.
// Production code keeps plain fetch; this transport is injected here only.
//
// Prints statuses, counts, shapes and masked ids — never tokens,
// credentials, emails or student ids.
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";

// The lib files use extensionless relative imports (bundler style); let
// node resolve them to .ts. Registered before the dynamic imports below.
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown,
) => unknown;
// registerHooks is newer than the installed @types/node.
(nodeModule as unknown as { registerHooks: (hooks: { resolve: ResolveHook }) => void }).registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // fall through to the plain specifier
      }
    }
    return nextResolve(specifier, context);
  },
});

const ps = await import("../lib/gradebook/powerschool");
const payloads = await import("../lib/gradebook/powerschoolPayloads");
const scores = await import("../lib/gradebook/powerschoolScoreBodyUnconfirmed");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const teacherEmail = args[0]?.startsWith("--") ? undefined : args[0]?.toLowerCase();
const sectionDcid = flag("--section");
const cleanupId = flag("--cleanup");
const write = args.includes("--write");
const studentCount = Math.max(1, Math.min(10, Number(flag("--students") ?? 3)));
const out = flag("--out");

const base = (process.env.PS_BASE_URL ?? "").replace(/\/$/, "");
const connectIp = process.env.PS_CONNECT_IP;
const caFile = process.env.PS_CA_FILE?.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const clientId = process.env.PS_CLIENT_ID;
const clientSecret = process.env.PS_CLIENT_SECRET;

if (!base || !clientId || !clientSecret) {
  console.error("PS_BASE_URL, PS_CLIENT_ID and PS_CLIENT_SECRET must be set (run through ~/ps-env.sh run).");
  process.exit(2);
}
if (!teacherEmail || (!sectionDcid && !cleanupId)) {
  console.error("usage: ps-send-check.ts <teacher-email> --section <dcid> [--write] | --cleanup <assignmentid>");
  process.exit(2);
}

const baseUrl = new URL(base);
const ca = caFile ? readFileSync(caFile) : undefined;

// ── pinned transport ─────────────────────────────────────────────────────

function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  servername = baseUrl.hostname,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: connectIp ?? baseUrl.hostname,
        port: baseUrl.port || 443,
        servername,
        ca,
        method,
        path,
        headers: { Host: baseUrl.host, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h[k] = v;
          resolve({ status: res.statusCode ?? 0, headers: h, text });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// A fetch for the app's client: same URL contract, pinned connection.
const pinnedFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const url = new URL(input);
  if (url.host !== baseUrl.host) throw new Error(`refusing a request to another host: ${url.host}`);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const body = typeof init?.body === "string" ? init.body : undefined;
  const res = await rawRequest(init?.method ?? "GET", url.pathname + url.search, headers, body);
  const noBody = res.status === 204 || res.status === 304;
  return new Response(noBody ? null : res.text, { status: res.status, headers: res.headers });
};

try {
  await rawRequest("GET", "/", {}, undefined, "wrong-name.invalid");
  console.error("self-check FAILED: a wrong server name was accepted — stopping.");
  process.exit(1);
} catch (e) {
  const code = (e as { code?: string }).code ?? String(e);
  if (code !== "ERR_TLS_CERT_ALTNAME_INVALID") {
    console.error(`self-check inconclusive: ${code} — fix PS_CA_FILE first.`);
    process.exit(1);
  }
  console.log(`── self-check ok: a wrong server name is refused (${code})`);
}

const client = ps.createLivePowerSchoolClient({ baseUrl: base, clientId, clientSecret, fetch: pinnedFetch });

// Schema-table reads for lookups (the plugin's granted fields), through the
// same token the client caches — one extra token here keeps the client's
// interface untouched.
let bearer = "";
async function bearerToken(): Promise<string> {
  if (bearer) return bearer;
  const res = await pinnedFetch(`${base}/oauth/access_token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  bearer = ((await res.json()) as { access_token: string }).access_token;
  return bearer;
}

type Row = Record<string, string | undefined>;
async function table(name: string, projection: string, q: string, pagesize = 100): Promise<{ status: number; rows: Row[]; error?: string }> {
  const params = new URLSearchParams({ projection, pagesize: String(pagesize), q });
  const res = await pinnedFetch(`${base}/ws/schema/table/${name}?${params}`, {
    headers: { Authorization: `Bearer ${await bearerToken()}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, rows: [], error: mask(text.slice(0, 200)) };
  const body = JSON.parse(text || "{}") as { record?: Array<{ tables?: Record<string, Row> }> };
  return { status: res.status, rows: (body.record ?? []).map((r) => r.tables?.[name] ?? {}) };
}

async function getJson(path: string): Promise<{ status: number; json: unknown; text: string }> {
  const res = await pinnedFetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${await bearerToken()}`, Accept: "application/json" },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

// ── output helpers ───────────────────────────────────────────────────────

/** Every run of 4+ digits masked — ids never reach the terminal. */
function mask(text: string): string {
  return text.replace(/\d{4,}/g, (m) => `#${m.length}d`);
}

function keepsValue(key: string): boolean {
  return new Set([
    "_name",
    "scoretype",
    "publishoption",
    "actualscorekind",
    "totalpointvalue",
    "scoreentrypoints",
    "weight",
    "scorepoints",
    "actualscoreentered",
    "ismissing",
    "isexempt",
    "islate",
    "iscountedinfinalgrade",
    "isscoringneeded",
  ]).has(key.toLowerCase());
}

function shapeOf(v: unknown, key = ""): unknown {
  if (v === null || v === undefined) return "<null>";
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return keepsValue(key) ? v : "<number>";
  if (typeof v === "string") {
    if (keepsValue(key) || v === "true" || v === "false") return v;
    if (/^-?\d+(\.\d+)?$/.test(v)) return "<numeric-string>";
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.replace(/\d/g, "9");
    return key.toLowerCase().includes("name") ? "<string>" : mask(v.slice(0, 120));
  }
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], key), `<${v.length} item(s)>`] : [];
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shapeOf(x, k)]));
  }
  return `<${typeof v}>`;
}

const say = (label: string, text: string) => console.log(`${label.padEnd(44)} ${text}`);
const record: Record<string, unknown> = { run_on: new Date().toISOString().slice(0, 10), write };

function explain(err: unknown): string {
  if (err instanceof ps.GradebookHttpError) return `HTTP ${err.status} (${err.stage}): ${mask(err.body.slice(0, 600))}`;
  return mask(String(err));
}

// ── resolve the teacher ──────────────────────────────────────────────────

const user = await table("users", "dcid", `email_addr==${teacherEmail}`, 1);
const usersDcid = user.rows[0]?.dcid;
if (!usersDcid) {
  say("users by email", user.error ? `HTTP ${user.status} ${user.error}` : "not found — stopping");
  process.exit(1);
}
say("users by email", "found");

if (cleanupId) {
  const res = await pinnedFetch(
    `${base}/ws/xte/section/assignment/${encodeURIComponent(cleanupId)}?${new URLSearchParams({ users_dcid: usersDcid, force: "true" })}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${await bearerToken()}`, Accept: "application/json" } },
  );
  const text = await res.text();
  say("DELETE section/assignment/{id}?force=true", `HTTP ${res.status}${text ? ` ${mask(text.slice(0, 300))}` : ""}`);
  process.exit(res.ok ? 0 : 1);
}

// ── the section, its term, and that the teacher teaches it ───────────────

const sec = await table("sections", "id,dcid,termid", `dcid==${sectionDcid}`, 1);
const section = sec.rows[0];
if (!section?.id || !section.termid) {
  say("section by dcid", sec.error ? `HTTP ${sec.status} ${sec.error}` : "not found — stopping");
  process.exit(1);
}
const termId = section.termid;
const yearId = String(Math.floor(Number(termId) / 100));
say("section by dcid", `found (year_id derived from termid: ${yearId})`);

const staff = await table("schoolstaff", "id,users_dcid", `users_dcid==${usersDcid}`, 20);
let teaches = false;
for (const s of staff.rows) {
  if (!s.id) continue;
  const st = await table("sectionteacher", "sectionid,teacherid", `teacherid==${s.id};sectionid==${section.id}`, 5);
  if (st.rows.length) teaches = true;
}
say("teacher teaches the section", teaches ? "yes" : "NO — stopping (the tool's authorization would refuse this)");
if (!teaches) process.exit(1);

// ── students: enrolled in the section, with a DCID ───────────────────────

const cc = await table("cc", "sectionid,studentid", `sectionid==${section.id}`, 100); // the API caps pagesize at 100
const studentIds = [...new Set(cc.rows.map((r) => r.studentid).filter((x): x is string => !!x))];
say("enrolments (cc.sectionid == section.id)", cc.error ? `HTTP ${cc.status} ${cc.error}` : `${studentIds.length} student(s)`);
const studentDcids: string[] = [];
for (const id of studentIds) {
  if (studentDcids.length >= studentCount) break;
  const st = await table("students", "id,dcid", `id==${id}`, 1);
  if (st.rows[0]?.dcid) studentDcids.push(st.rows[0].dcid);
}
say("students chosen for synthetic scores", String(studentDcids.length));
if (studentDcids.length === 0) process.exit(1);

// ── category (D-6: district "Test" when active, else an explicit pick) ───

const categories = await client.listCategories(usersDcid, yearId);
const active = payloads.activeCategories(categories);
const categoryId = flag("--category") ?? payloads.defaultCategoryId(categories);
const category = active.find((c) => c.id === categoryId);
say("categories", `${categories.length} total, ${active.length} active; D-6 default ${payloads.defaultCategoryId(categories) ? "present" : "none (pick required)"}`);
if (categories.length === 0) {
  // The client read nothing: show what the same URL answers, as a shape.
  const raw = await getJson(`/ws/xte/teacher_category?${new URLSearchParams({ users_dcid: usersDcid, year_id: yearId })}`);
  say("teacher_category (direct read)", `HTTP ${raw.status}, ${typeof raw.json}${Array.isArray(raw.json) ? ` array of ${raw.json.length}` : ""}`);
  console.log(JSON.stringify(shapeOf(raw.json), null, 2).slice(0, 1500));
}
if (!category) {
  console.log("Pass --category <teachercategoryid>, one of the active categories:");
  for (const c of active) console.log(`   ${c.id.padEnd(10)} ${c.name}`);
  process.exit(flag("--category") ? 1 : 0);
}
say("category", `${category.name} (publish ${category.defaultpublishoption ?? "?"})`);

// ── due date: --due, else the latest due date already in the section ─────

let due = flag("--due");
if (!due) {
  const list = await getJson(`/ws/xte/section/assignment/?${new URLSearchParams({ users_dcid: usersDcid, section_ids: sectionDcid! })}`);
  const dates = JSON.stringify(list.json).match(/"duedate":"(\d{4}-\d{2}-\d{2})/g) ?? [];
  due = dates.map((d) => d.slice(-10)).sort().at(-1);
}
if (!due) {
  console.log("No due date found in the section — pass --due YYYY-MM-DD (inside the 2024-25 term).");
  process.exit(1);
}
say("due date", due);

// ── bodies, built by the app's code ──────────────────────────────────────

const MAX = 10;
const createBody = payloads.buildAssignmentCreateBody({
  sectionDcid: sectionDcid!,
  name: `Secure Test check ${record.run_on}`,
  dueDate: due,
  maxPoints: MAX,
  categoryId: category.id,
  publishOption: category.defaultpublishoption,
});
console.log("── create body (ids masked)");
console.log(JSON.stringify(shapeOf(createBody), null, 2));
record.create_body = shapeOf(createBody);

const firstPoints = studentDcids.map((_, i) => MAX - 1 - i); // 9, 8, 7 …
const sampleScoreBody = scores.buildScoreWriteBodyUnconfirmed(
  "0",
  studentDcids.map((d, i) => ({ studentDcid: d, points: firstPoints[i]!, externalScoreId: null })),
);
console.log("── score body (ids masked)");
console.log(JSON.stringify(shapeOf(sampleScoreBody), null, 2));

if (!write) {
  console.log("Read-only run. Add --write to create the assignment and write the scores on the TEST server.");
  finish();
}

// ── 1. create ────────────────────────────────────────────────────────────

console.log("── 1. create");
let assignmentSectionId: string | null = null;
let createdAssignmentId: string | null = null;
try {
  const created = await client.createAssignment(usersDcid, createBody);
  assignmentSectionId = created.assignmentSectionId;
  createdAssignmentId = created.assignmentId;
  record.create_response = shapeOf(created.raw);
  record.create_location = created.location ? mask(created.location) : null;
  say("create", `ok; assignmentsectionid ${assignmentSectionId ? "read" : "NOT readable"}, assignmentid ${createdAssignmentId ? "read" : "NOT readable"}`);
  say("create Location (masked)", created.location ? mask(created.location) : "none");
  if (created.location && createdAssignmentId && assignmentSectionId) {
    const tail = /(\d+)\/?$/.exec(created.location)?.[1];
    say(
      "Location ends in",
      tail === createdAssignmentId ? "the assignmentid" : tail === assignmentSectionId ? "the assignmentsectionid" : "neither id",
    );
  }
  console.log(JSON.stringify(record.create_response, null, 2));
} catch (err) {
  say("create", `FAILED ${explain(err)}`);
  finish(1);
}
if (!assignmentSectionId) {
  if (createdAssignmentId) console.log(`   created but unusable — clean up: --cleanup ${createdAssignmentId}`);
  finish(1);
}

// Read it back by listing the section and finding our assignmentsectionid.
const back = await getJson(`/ws/xte/section/assignment/?${new URLSearchParams({ users_dcid: usersDcid, section_ids: sectionDcid! })}`);
const ours = (Array.isArray(back.json) ? back.json : []).find((a: unknown) => {
  const text = JSON.stringify(a);
  return (
    text.includes(`"assignmentsectionid":${assignmentSectionId}`) ||
    text.includes(`"assignmentsectionid":"${assignmentSectionId}"`)
  );
}) as Record<string, unknown> | undefined;
const assignmentId = ours?.assignmentid !== undefined ? String(ours.assignmentid) : createdAssignmentId;
say("read back in the section list", ours ? "found" : `not found (HTTP ${back.status})`);
if (ours && createdAssignmentId) say("listed assignmentid = the create's", String(ours.assignmentid) === createdAssignmentId ? "yes" : "NO");
if (assignmentId) console.log(`   cleanup later: --cleanup ${assignmentId}`);
record.read_back = ours ? shapeOf(ours) : null;

async function readScores(label: string) {
  const r = await table(
    "assignmentscore",
    "assignmentscoreid,studentsdcid,scorepoints,actualscoreentered,actualscorekind",
    `assignmentsectionid==${assignmentSectionId}`,
    50,
  );
  if (r.error) {
    say(label, `ASSIGNMENTSCORE not readable: HTTP ${r.status} ${r.error}`);
    return new Map<string, Row>();
  }
  const byStudent = new Map(r.rows.map((row) => [row.studentsdcid ?? "", row]));
  const points = studentDcids.map((d) => byStudent.get(d)?.scorepoints ?? "—").join(", ");
  say(label, `${r.rows.length} score row(s); ours in order: ${points}`);
  return byStudent;
}

// ── 2. first score write ─────────────────────────────────────────────────

console.log("── 2. write scores");
const writeBody = scores.buildScoreWriteBodyUnconfirmed(
  assignmentSectionId!,
  studentDcids.map((d, i) => ({ studentDcid: d, points: firstPoints[i]!, externalScoreId: null })),
);
let scoreIds = new Map<string, string | null>();
try {
  const res = await client.writeScores(usersDcid, termId, writeBody);
  record.score_response = shapeOf(res);
  const parsed = scores.parseScoreWriteResponseUnconfirmed(res);
  scoreIds = new Map([...parsed.byStudentDcid].map(([k, v]) => [k, v.assignmentscoreid]));
  say("write", `ok; response names ${parsed.byStudentDcid.size} student(s), ${[...scoreIds.values()].filter(Boolean).length} with an assignmentscoreid`);
  console.log(JSON.stringify(record.score_response, null, 2));
} catch (err) {
  say("write", `FAILED ${explain(err)}`);
  finish(1);
}
const afterFirst = await readScores("read back (expect " + firstPoints.join(", ") + ")");

// ── 3. re-send one corrected score (D-7 update path) ─────────────────────

console.log("── 3. re-send one corrected score");
const target = studentDcids[0]!;
const knownId = scoreIds.get(target) ?? afterFirst.get(target)?.assignmentscoreid ?? null;
say("assignmentscoreid for the update", knownId ? (scoreIds.get(target) ? "from the write response" : "from the table read") : "none — sending without it");
const corrected = MAX;
try {
  const res = await client.writeScores(
    usersDcid,
    termId,
    scores.buildScoreWriteBodyUnconfirmed(assignmentSectionId!, [
      { studentDcid: target, points: corrected, externalScoreId: knownId },
    ]),
  );
  record.update_response = shapeOf(res);
  say("update", "ok");
} catch (err) {
  say("update", `FAILED ${explain(err)}`);
  finish(1);
}
const afterUpdate = await readScores(`read back (expect ${[corrected, ...firstPoints.slice(1)].join(", ")})`);
const rowsForTarget = [...afterUpdate.values()].filter((r) => r.studentsdcid === target).length;
say("rows for the corrected student", `${rowsForTarget} (1 = updated in place, >1 = duplicated)`);

finish();

function finish(code = 0): never {
  if (out) {
    writeFileSync(out.replace(/^~(?=\/)/, process.env.HOME ?? "~"), JSON.stringify(record, null, 2) + "\n");
    console.log(`written to ${out}`);
  }
  process.exit(code);
}
