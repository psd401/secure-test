// Read-only probe of the PowerSchool plugin's data access
// (docs/gradebook-push-design.md, slice 2). Answers one question before we
// build against the test server: can the fields IT granted on the plugin
// (v1.1, widened in v1.2 on 2026-09-28) be joined into teacher → section →
// student DCIDs, or do we need more?
//
//   PS_BASE_URL=https://<ps-test-host> PS_CONNECT_IP=<test-server-ip> \
//   PS_CA_FILE=~/ps-test.pem PS_CLIENT_ID=… PS_CLIENT_SECRET=… \
//   node scripts/ps-probe.ts [teacher-email]
//   node scripts/ps-probe.ts <teacher-email> --shapes [--course <text>] [--section <dcid>] [--out <file>]
//
// --shapes (slice 2a) skips the checks below and instead reads the
// gradebook side, still GET-only: the teacher's sections in the snapshot's
// latest year, the one whose course name contains --course (default
// "seminar") or the --section DCID, its /ws/xte/section/assignment list
// and the teacher's /ws/xte/teacher_category list. It prints SHAPES — every
// key with its value's type, values kept only for booleans and enum-like
// keys (scoretype, publishoption, …) — so the create / score payloads can be
// built against what PowerTeacher Pro really returns. --out writes the same
// shapes as JSON (point it under design-tool/samples/, which is gitignored).
//
// Run it with NODE, not bun (measured 2026-09-28): the test server's
// certificate is self-signed without the CA flag, which Node's OpenSSL
// accepts as a trust anchor and Bun's TLS refuses
// (UNABLE_TO_VERIFY_LEAF_SIGNATURE) even when it is the one trusted
// certificate. Node strips the types itself; nothing here is Bun-specific.
//
// The test server has no public DNS and a self-signed certificate (IT,
// 2026-09-25: trust it locally, never disable verification), and the
// maintainer has no admin rights for /etc/hosts. So the probe connects to
// PS_CONNECT_IP but presents and verifies the certificate against the
// hostname in PS_BASE_URL, trusting only PS_CA_FILE. Save the certificate:
//   openssl s_client -connect <test-server-ip>:443 \
//     -servername <ps-test-host> </dev/null | openssl x509 > ~/ps-test.pem
//   openssl x509 -in ~/ps-test.pem -noout -ext subjectAltName
//     — must list <ps-test-host>, or verification fails.
// Before anything else it asks for a deliberately wrong name and stops if
// that succeeds (the name check would not be working).
//
// Test-only transport, in a dev script: production code uses plain fetch
// with normal verification.
//
// Only GET requests after the token. Prints statuses, counts and whether
// joins matched — never field values (emails, student numbers), the token
// or the credentials.
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";

const base = (process.env.PS_BASE_URL ?? "").replace(/\/$/, "");
const connectIp = process.env.PS_CONNECT_IP;
const caFile = process.env.PS_CA_FILE?.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const clientId = process.env.PS_CLIENT_ID;
const clientSecret = process.env.PS_CLIENT_SECRET;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const teacherEmail = args[0]?.startsWith("--") ? undefined : args[0]?.toLowerCase();
const shapesMode = args.includes("--shapes");

if (!base || !clientId || !clientSecret) {
  console.error("PS_BASE_URL, PS_CLIENT_ID and PS_CLIENT_SECRET must be set.");
  process.exit(2);
}
if (shapesMode && !teacherEmail) {
  console.error("--shapes needs the teacher email as the first argument.");
  process.exit(2);
}

const baseUrl = new URL(base);
const ca = caFile ? readFileSync(caFile) : undefined;

type Reply = { status: number; ok: boolean; text: string };

// One HTTPS request: TCP to connectIp (or the host), TLS SNI + identity
// check against `servername`, only `ca` trusted when given.
function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  servername = baseUrl.hostname,
): Promise<Reply> {
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
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, text });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

type Row = Record<string, string | undefined>;
type Result = { status: number; rows: Row[]; count?: number; error?: string };

async function token(): Promise<string> {
  const res = await request(
    "POST",
    "/oauth/access_token/",
    {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    "grant_type=client_credentials",
  );
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  const body = JSON.parse(res.text) as { access_token?: string };
  if (!body.access_token) throw new Error("token: no access_token in the response");
  return body.access_token;
}

let bearer = "";

// GET /ws/schema/table/<table>?projection=…&q=…&pagesize=… — flattens each
// record's `tables.<table>` object, keeps the record-level `id` as `_id`.
async function table(name: string, projection: string, q?: string, pagesize = 5, page = 1): Promise<Result> {
  const params = new URLSearchParams({ projection, pagesize: String(pagesize), page: String(page) });
  if (q) params.set("q", q);
  const res = await request("GET", `/ws/schema/table/${name}?${params}`, {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
  });
  const text = res.text;
  if (!res.ok) return { status: res.status, rows: [], error: text.slice(0, 160).replace(/\s+/g, " ") };
  const body = JSON.parse(text || "{}") as {
    record?: Array<{ id?: string | number; tables?: Record<string, Row> }>;
  };
  const rows = (body.record ?? []).map((r) => ({
    _id: r.id === undefined ? undefined : String(r.id),
    ...(r.tables?.[name] ?? {}),
  }));
  return { status: res.status, rows };
}

async function count(name: string): Promise<string> {
  const res = await request("GET", `/ws/schema/table/${name}/count`, {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
  });
  if (!res.ok) return `HTTP ${res.status}`;
  const body = JSON.parse(res.text) as { count?: number; resource?: { count?: number } };
  return String(body.count ?? body.resource?.count ?? "?");
}

// Which fields came back with a value — names only.
function fieldsSeen(r: Result): string {
  const seen = new Set<string>();
  for (const row of r.rows) for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== "") seen.add(k);
  return [...seen].sort().join(",") || "(none)";
}

function line(label: string, r: Result) {
  const outcome = r.error ? `HTTP ${r.status} ${r.error}` : `ok, ${r.rows.length} row(s), fields: ${fieldsSeen(r)}`;
  console.log(`${label.padEnd(44)} ${outcome}`);
}

// Self-check: a wrong name must fail TLS verification. If it does not, the
// name check is not working and nothing below is verified — stop.
try {
  await request("GET", "/", {}, undefined, "wrong-name.invalid");
  console.error("self-check FAILED: a wrong server name was accepted — stopping.");
  process.exit(1);
} catch (e) {
  // Only a name mismatch proves the name check works. Any other failure
  // (an untrusted chain, a network error) means the trust setup is wrong
  // and the check proved nothing — stop and say so.
  const code = (e as { code?: string }).code ?? String(e);
  if (code !== "ERR_TLS_CERT_ALTNAME_INVALID") {
    console.error(`self-check inconclusive: ${code} — the connection failed before the name was checked.`);
    console.error("Fix the trust in PS_CA_FILE first (it must hold the certificate that SIGNED the server's, not only the server's own).");
    process.exit(1);
  }
  console.log(`── self-check ok: a wrong server name is refused (${code})`);
}

try {
  bearer = await token();
} catch (e) {
  console.error(String(e), "— if this is a certificate error, see the header of this file.");
  process.exit(1);
}
console.log(`── token ok (${base})`);

if (shapesMode) {
  await shapes();
  process.exit(0);
}

console.log("── granted on plugin v1.1 + v1.2");
const granted: Array<[string, string]> = [
  ["users", "dcid,email_addr"],
  ["sections", "dcid,id,termid,schoolid"],
  ["cc", "sectionid,studentid"],
  ["students", "dcid,id,student_number"],
  ["terms", "yearid"],
  ["sectionteacher", "sectionid,teacherid"],
  ["schoolstaff", "id,users_dcid"],
];
const g: Record<string, Result> = {};
for (const [t, p] of granted) {
  g[t] = await table(t, p);
  line(`${t} [${p}] (count ${await count(t)})`, g[t]);
}

console.log("── not requested (expect refusals; a success changes the plan)");
for (const [t, p] of [["terms", "id"]] as const) {
  line(`${t} [${p}]`, await table(t, p));
}

console.log("── joins");
// CC.SECTIONID → SECTIONS.ID (ID was granted).
const cc = g.cc?.rows.find((r) => r.sectionid && r.studentid);
if (!cc) {
  console.log("no CC row with sectionid + studentid — cannot test joins");
} else {
  const bySection = await table("sections", "dcid,id", `id==${cc.sectionid}`, 1);
  console.log(`cc.sectionid → sections.id                   ${bySection.rows.length ? "MATCH" : `no match${bySection.error ? ` (HTTP ${bySection.status})` : ""}`}`);

  // CC.STUDENTID is STUDENTS.ID in the PowerSchool schema; ID is granted
  // since v1.2, so the join is read directly and DCID comes back beside it.
  const byId = await table("students", "id,dcid", `id==${cc.studentid}`, 1);
  const hit = byId.rows[0];
  console.log(
    `cc.studentid → students.id                   ${byId.error ? `HTTP ${byId.status} ${byId.error}` : hit ? `MATCH (dcid ${hit.dcid ? "present" : "MISSING"}; id ${hit.id === hit.dcid ? "==" : "!="} dcid on this row)` : "no match"}`,
  );

  // Sample up to 200 enrolments: does every CC.STUDENTID resolve through
  // STUDENTS.ID to a row with a DCID, and how often is ID = DCID (the
  // common PowerSchool pattern — informational only, nothing builds on it).
  const ids = new Set<string>();
  for (const page of [1, 2]) {
    const r = await table("cc", "studentid", undefined, 100, page);
    for (const row of r.rows) if (row.studentid) ids.add(row.studentid);
  }
  const sample = [...ids].slice(0, 200);
  let matched = 0;
  let withDcid = 0;
  let idEqualsDcid = 0;
  let failed = 0;
  for (let i = 0; i < sample.length; i += 10) {
    const hits = await Promise.all(
      sample.slice(i, i + 10).map((id) => table("students", "id,dcid", `id==${id}`, 1)),
    );
    for (const h of hits) {
      if (h.error) failed++;
      else if (h.rows.length) {
        matched++;
        if (h.rows[0].dcid) withDcid++;
        if (h.rows[0].id === h.rows[0].dcid) idEqualsDcid++;
      }
    }
  }
  console.log(
    `cc.studentid → students.id → dcid            ${matched} of ${sample.length} resolve, ${withDcid} with a dcid, ${idEqualsDcid} where id == dcid${failed ? ` (${failed} lookups failed)` : ""}`,
  );
}

if (teacherEmail) {
  console.log("── teacher");
  // USERS.DCID → SCHOOLSTAFF.USERS_DCID → SCHOOLSTAFF.ID = SECTIONTEACHER.TEACHERID
  // → SECTIONTEACHER.SECTIONID = SECTIONS.ID → SECTIONS.DCID.
  const u = await table("users", "dcid", `email_addr==${teacherEmail}`, 1);
  const usersDcid = u.rows[0]?.dcid;
  console.log(`users by email                               ${u.error ? `HTTP ${u.status}` : usersDcid ? "found" : "not found"}`);
  if (usersDcid) {
    const staff = await table("schoolstaff", "id,users_dcid", `users_dcid==${usersDcid}`, 20);
    const staffIds = staff.rows.map((r) => r.id).filter((x): x is string => !!x);
    console.log(`users.dcid → schoolstaff.users_dcid          ${staff.error ? `HTTP ${staff.status} ${staff.error}` : `${staffIds.length} staff row(s)`}`);
    let sectionIds: string[] = [];
    for (const sid of staffIds) {
      const st = await table("sectionteacher", "sectionid,teacherid", `teacherid==${sid}`, 100);
      if (st.error) {
        console.log(`schoolstaff.id → sectionteacher.teacherid    HTTP ${st.status} ${st.error}`);
        break;
      }
      sectionIds.push(...st.rows.map((r) => r.sectionid).filter((x): x is string => !!x));
    }
    sectionIds = [...new Set(sectionIds)];
    console.log(`schoolstaff.id → sectionteacher.teacherid    ${sectionIds.length} distinct section id(s)`);
    let withDcid = 0;
    for (const sid of sectionIds.slice(0, 50)) {
      const sec = await table("sections", "id,dcid", `id==${sid}`, 1);
      if (sec.rows[0]?.dcid) withDcid++;
    }
    console.log(`sectionteacher.sectionid → sections.dcid     ${withDcid} of ${Math.min(sectionIds.length, 50)} resolve to a section dcid`);
  }
}

// ── --shapes (slice 2a) ─────────────────────────────────────────────────

// Keys whose values are enums or point settings, not identities — kept in
// the shapes so the payload builders can match them. A function, not a
// module const: shapes() runs before the module body reaches this line.
function keepsValue(key: string): boolean {
  return new Set([
  "scoretype",
  "publishoption",
  "defaultpublishoption",
  "defaultpublishstate",
  "defaultscoretype",
  "categorytype",
  "actualscorekind",
  "calculationrelationship",
  "standardscoringmethod",
  "totalpointvalue",
  "scoreentrypoints",
  "extracreditpoints",
  "weight",
  "districtteachercategoryid",
  "displayposition",
  "defaultscoreentrypoints",
  "defaultweight",
  "defaulttotalvalue",
    "_name", // PowerSchool's object type tag (e.g. which table a record is)
  ]).has(key.toLowerCase());
}

// Every key with its value's type; values only for booleans and keepsValue()
// keys; an array is shown by its first element.
function shapeOf(v: unknown, key = ""): unknown {
  if (v === null || v === undefined) return "<null>";
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return keepsValue(key) ? v : "<number>";
  if (typeof v === "string") {
    if (keepsValue(key)) return v;
    if (v === "true" || v === "false") return v;
    if (/^-?\d+(\.\d+)?$/.test(v)) return "<numeric-string>";
    // Dates keep their format with digits masked, e.g. "9999-99-99".
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.replace(/\d/g, "9");
    return "<string>";
  }
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], key), `<${v.length} item(s)>`] : [];
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shapeOf(x, k)]));
  }
  return `<${typeof v}>`;
}

async function getJson(path: string): Promise<{ status: number; body?: unknown; error?: string }> {
  const res = await request("GET", path, { Authorization: `Bearer ${bearer}`, Accept: "application/json" });
  if (!res.ok) return { status: res.status, error: res.text.slice(0, 160).replace(/\s+/g, " ") };
  return { status: res.status, body: res.text ? JSON.parse(res.text) : undefined };
}

// Arrays anywhere in a body, first match by key predicate — the xte list
// wrappers are not documented, so find the records rather than assume.
function firstArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const a = firstArray(x);
      if (a.length) return a;
    }
  }
  return [];
}

async function pagedTable(name: string, projection: string, q: string): Promise<Result> {
  const rows: Row[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await table(name, projection, q, 100, page);
    if (r.error) return r;
    rows.push(...r.rows);
    if (r.rows.length < 100) break;
  }
  return { status: 200, rows };
}

async function shapes() {
  const course = (flag("--course") ?? "seminar").toLowerCase();
  const wantSection = flag("--section");
  const out = flag("--out");
  const say = (label: string, text: string) => console.log(`${label.padEnd(44)} ${text}`);

  console.log("── teacher → sections");
  const u = await table("users", "dcid", `email_addr==${teacherEmail}`, 1);
  const usersDcid = u.rows[0]?.dcid;
  if (!usersDcid) return say("users by email", u.error ? `HTTP ${u.status}` : "not found — stopping");
  say("users by email", "found");

  const staff = await table("schoolstaff", "id,users_dcid", `users_dcid==${usersDcid}`, 20);
  const sectionIds = new Set<string>();
  for (const s of staff.rows) {
    if (!s.id) continue;
    const st = await pagedTable("sectionteacher", "sectionid,teacherid", `teacherid==${s.id}`);
    if (st.error) return say("sectionteacher", `HTTP ${st.status} ${st.error}`);
    for (const r of st.rows) if (r.sectionid) sectionIds.add(r.sectionid);
  }
  say("distinct section ids", String(sectionIds.size));

  // course_number is not on the granted list; ask anyway and fall back.
  let withCourse = true;
  const sections: Row[] = [];
  const ids = [...sectionIds];
  for (let i = 0; i < ids.length; i += 10) {
    const hits = await Promise.all(
      ids.slice(i, i + 10).map((id) =>
        table("sections", withCourse ? "id,dcid,termid,course_number" : "id,dcid,termid", `id==${id}`, 1),
      ),
    );
    if (withCourse && hits.some((h) => h.error)) {
      say("sections.course_number", `refused (HTTP ${hits.find((h) => h.error)?.status}) — name match unavailable`);
      withCourse = false;
      i -= 10;
      continue;
    }
    for (const h of hits) if (h.rows[0]) sections.push(h.rows[0]);
  }
  const yearOf = (r: Row) => Math.floor(Number(r.termid) / 100);
  const yearId = Math.max(...sections.map(yearOf).filter((n) => Number.isFinite(n)));
  const inYear = sections.filter((r) => yearOf(r) === yearId);
  say("latest year in the snapshot", `year_id ${yearId}, ${inYear.length} of the teacher's sections`);

  let chosen: Row | undefined;
  if (wantSection) {
    chosen = inYear.find((r) => r.dcid === wantSection);
    say("--section", chosen ? "found among the teacher's sections" : "NOT among the teacher's sections in that year");
  } else if (withCourse) {
    const numbers = [...new Set(inYear.map((r) => r.course_number).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    for (const n of numbers) {
      const c = await table("courses", "course_number,course_name", `course_number==${n}`, 1);
      if (c.error) {
        say("courses.course_name", `refused (HTTP ${c.status}) — pass --section <dcid>`);
        break;
      }
      if (c.rows[0]?.course_name) names.set(n, c.rows[0].course_name);
    }
    const matches = inYear.filter((r) => names.get(r.course_number ?? "")?.toLowerCase().includes(course));
    say(`sections whose course name has "${course}"`, String(matches.length));
    chosen = matches[0];
    if (chosen) say("chosen", names.get(chosen.course_number ?? "") ?? "?");
  }
  if (!chosen) {
    console.log("No section chosen. Pass --section <dcid> (read it from the test server's PowerSchool UI).");
    return;
  }

  console.log("── gradebook reads (GET only)");
  const result: Record<string, unknown> = { read_on: new Date().toISOString().slice(0, 10) };

  const cats = await getJson(`/ws/xte/teacher_category?users_dcid=${usersDcid}&year_id=${yearId}`);
  const catRows = firstArray(cats.body) as Array<Record<string, unknown>>;
  say("teacher_category", cats.error ? `HTTP ${cats.status} ${cats.error}` : `${catRows.length} categor(ies)`);
  for (const c of catRows) {
    console.log(
      `   ${String(c.name ?? "?").padEnd(24)} district ${String(c.districtteachercategoryid ?? "-").padEnd(4)} active ${String(c.isactive).padEnd(5)} publish ${String(c.defaultpublishoption ?? "?")}`,
    );
  }
  result.teacher_category = shapeOf(cats.body);

  const list = await getJson(`/ws/xte/section/assignment/?users_dcid=${usersDcid}&section_ids=${chosen.dcid}`);
  const assignments = firstArray(list.body) as Array<Record<string, unknown>>;
  say("section/assignment (chosen section)", list.error ? `HTTP ${list.status} ${list.error}` : `${assignments.length} assignment(s)`);
  result.section_assignment_list = shapeOf(list.body);

  // Prefer a points assignment: that is what we will create.
  const text = (a: unknown) => JSON.stringify(a);
  const sample = assignments.find((a) => /"scoretype":"POINTS"/i.test(text(a))) ?? assignments[0];
  const sampleId = sample?.assignmentid ?? sample?.id;
  if (sampleId !== undefined) {
    const one = await getJson(`/ws/xte/section/assignment/${sampleId}?users_dcid=${usersDcid}`);
    say("section/assignment/{id}", one.error ? `HTTP ${one.status} ${one.error}` : "ok");
    result.section_assignment_one = shapeOf(one.body);
  }

  console.log("── shapes");
  console.log(JSON.stringify(result, null, 2));
  if (out) {
    writeFileSync(out.replace(/^~(?=\/)/, process.env.HOME ?? "~"), JSON.stringify(result, null, 2) + "\n");
    console.log(`written to ${out}`);
  }
}
