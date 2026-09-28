// Read-only probe of the PowerSchool plugin's data access
// (docs/gradebook-push-design.md, slice 2). Answers one question before we
// build against the test server: can the fields IT granted on plugin v1.1
// be joined into teacher → section → student DCIDs, or do we need more?
//
//   PS_BASE_URL=https://<ps-test-host> PS_CONNECT_IP=<test-server-ip> \
//   PS_CA_FILE=~/ps-test.pem PS_CLIENT_ID=… PS_CLIENT_SECRET=… \
//   node scripts/ps-probe.ts [teacher-email]
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
import { readFileSync } from "node:fs";

const base = (process.env.PS_BASE_URL ?? "").replace(/\/$/, "");
const connectIp = process.env.PS_CONNECT_IP;
const caFile = process.env.PS_CA_FILE?.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const clientId = process.env.PS_CLIENT_ID;
const clientSecret = process.env.PS_CLIENT_SECRET;
const teacherEmail = process.argv[2]?.toLowerCase();

if (!base || !clientId || !clientSecret) {
  console.error("PS_BASE_URL, PS_CLIENT_ID and PS_CLIENT_SECRET must be set.");
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

console.log("── granted on plugin v1.1");
const granted: Array<[string, string]> = [
  ["users", "dcid,email_addr"],
  ["sections", "dcid,id,termid,schoolid"],
  ["cc", "sectionid,studentid"],
  ["students", "dcid,student_number"],
  ["terms", "yearid"],
];
const g: Record<string, Result> = {};
for (const [t, p] of granted) {
  g[t] = await table(t, p);
  line(`${t} [${p}] (count ${await count(t)})`, g[t]);
}

console.log("── not requested (expect refusals; a success changes the plan)");
for (const [t, p] of [
  ["students", "id"],
  ["terms", "id"],
  ["sectionteacher", "sectionid,teacherid"],
  ["schoolstaff", "id,users_dcid"],
] as const) {
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

  // CC.STUDENTID is STUDENTS.ID in the PowerSchool schema; ID was not
  // granted. Try a filter on id (may be refused), then on dcid (in case
  // the record-level id or dcid happens to carry the same value).
  const byId = await table("students", "dcid", `id==${cc.studentid}`, 1);
  console.log(`cc.studentid → students.id (filter)          ${byId.error ? `HTTP ${byId.status} ${byId.error}` : byId.rows.length ? "MATCH" : "no match"}`);
  const byDcid = await table("students", "dcid", `dcid==${cc.studentid}`, 1);
  console.log(`cc.studentid → students.dcid (filter)        ${byDcid.error ? `HTTP ${byDcid.status}` : byDcid.rows.length ? "match on this row (ID = DCID here? see the sample below)" : "no match"}`);
  const s = g.students?.rows[0];
  console.log(`students record-level id == dcid?            ${s ? (s._id === s.dcid ? "yes (id = DCID, not STUDENTS.ID)" : `no (record id is a different key)`) : "no student row"}`);

  // One row cannot tell a coincidence from the common PowerSchool pattern
  // of STUDENTS.ID = STUDENTS.DCID. Sample up to 200 enrolments and count
  // how many CC.STUDENTID values exist as a student DCID. Evidence, not
  // proof: a DCID match does not show it is the SAME student — only
  // reading STUDENTS.ID beside DCID would.
  const ids = new Set<string>();
  for (const page of [1, 2]) {
    const r = await table("cc", "studentid", undefined, 100, page);
    for (const row of r.rows) if (row.studentid) ids.add(row.studentid);
  }
  const sample = [...ids].slice(0, 200);
  let matched = 0;
  let failed = 0;
  for (let i = 0; i < sample.length; i += 10) {
    const hits = await Promise.all(
      sample.slice(i, i + 10).map((id) => table("students", "dcid", `dcid==${id}`, 1)),
    );
    for (const h of hits) {
      if (h.error) failed++;
      else if (h.rows.length) matched++;
    }
  }
  console.log(
    `cc.studentid found as a students.dcid        ${matched} of ${sample.length} distinct student ids${failed ? ` (${failed} lookups failed)` : ""}`,
  );
}

if (teacherEmail) {
  console.log("── teacher");
  const u = await table("users", "dcid", `email_addr==${teacherEmail}`, 1);
  console.log(`users by email                               ${u.error ? `HTTP ${u.status}` : u.rows.length ? "found" : "not found"}`);
  // No granted table links USERS to SECTIONS; sectionteacher / schoolstaff
  // above say whether that path is open.
}
