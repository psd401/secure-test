// Dev-only: the fixtures for the graphing-calculator client hand rows
// (client/MANUAL-CHECKS.md, Row DC). Imports three tests as the demo teacher,
// publishes them, opens a 240-minute sitting on each, and writes a demo
// student's token for the client. Written 2026-10-22 after a shutdown lost the
// scratchpad copy of this recipe; docs/ledger.md (2026-10-22) has the launch.
//
//   DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_gc_demo \
//     bun --env-file=.env.local run dev -- -p 3010            # the server, first
//   bun --env-file=.env.local scripts/hand-run-calculator.ts <out-dir> [base-url] [student-index]
//
// Needs DESIGN_TOOL_SESSION_SECRET (from .env.local) to match the server's.
// The database must already hold the demo roster (scripts/seed-demo.ts). Each
// run imports new tests, so earlier sittings stay as they were. Prints one
// line per sitting: title, assessment id, join code.
import { mintSessionJWT } from "../lib/auth/session";
import { DEMO_TEACHER, demoStudents } from "../lib/dev/demoRoster";

const [outDir, base = "http://localhost:3010", studentIndex = "0"] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: bun --env-file=.env.local scripts/hand-run-calculator.ts <out-dir> [base-url] [student-index]");
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("hand-run-calculator is a dev tool; base-url must be a local server");
  process.exit(2);
}
const student = demoStudents()[Number(studentIndex)];
if (!student) {
  console.error(`no demo student at index ${studentIndex}`);
  process.exit(2);
}

const cookie = `secure-test-session=${await mintSessionJWT({
  sub: DEMO_TEACHER.sub,
  role: "staff",
  email: DEMO_TEACHER.email,
  hd: DEMO_TEACHER.email.split("@")[1],
})}`;
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

const u = () => crypto.randomUUID();
const stim = {
  rows: [{ latex: "y=x^{2}-4", color: "#1f5fa8" }, { latex: "y=2x-1", color: "#b42b2b" }],
  view: { xmin: -6, xmax: 6, ymin: -6, ymax: 10 },
  alt: "A graph of y = x² − 4 and y = 2x − 1, with x from −6 to 6 and y from −6 to 10.",
};
const bundles = [
  {
    // Q1 calculator answer 8.75; Q2 stimulus, intersections (3, 5) and (−1, −3);
    // Q3 no-calculator; Q4 board edge with snap 2; Q5 clear-all-then-resume.
    test_id: u(), title: "Client hand-run — graphing", student_layout: "paged",
    calculator: { mode: "graphing", preset: "state_wa" },
    items: [
      { type: "short_text", id: u(), stem: "Use the calculator: what is $\\frac{3}{4}+\\sqrt{16}\\times 2$?", correct_answer: "8.75" },
      { type: "short_text", id: u(), stem: "Where do the two graphs meet with a positive $x$? Write the point.", graph: stim, correct_answer: "(3, 5)" },
      { type: "short_text", id: u(), stem: "No calculator here: what is $7 \\times 8$?", no_calculator: true, correct_answer: "56" },
      { type: "graph", id: u(), stem: "Plot the point $(4, 0)$. (Board −5 to 5, snap 2: try the right edge.)",
        board: { x: [-5, 5], y: [-5, 5], grid: 1, snap: "2", tools: ["point", "line"], max_objects: 2 },
        key: { objects: [{ tool: "point", points: [[4, 0]] }], scoring: "per_object" } },
      { type: "graph", id: u(), stem: "Graph the line $y = 2x + 1$ and the point $(4, 6)$.",
        board: { x: [0, 20], y: [0, 20], grid: 1, snap: "1/2", tools: ["point", "line", "circle"], max_objects: 2 },
        key: { objects: [{ tool: "line", points: [[0, 1], [2, 5]] }, { tool: "point", points: [[4, 6]] }], scoring: "per_object" } },
    ],
  },
  {
    test_id: u(), title: "Client hand-run — scientific", calculator: { mode: "scientific", preset: "full" },
    items: [{ type: "short_text", id: u(), stem: "What is $\\frac{3}{4}+\\sqrt{16}\\times 2$?", correct_answer: "8.75" }],
  },
  {
    // State-test preset: no √ key.
    test_id: u(), title: "Client hand-run — four-function", calculator: { mode: "four_function", preset: "state_wa" },
    items: [{ type: "short_text", id: u(), stem: "What is $12 \\div 4 + 5$?", correct_answer: "8" }],
  },
];

const out: string[] = [];
for (const b of bundles) {
  const imp = await call("POST", "/api/assessments/import", b);
  const id = imp.assessment.id;
  await call("PATCH", `/api/assessments/${id}`, { status: "published" });
  const s = await call("POST", "/api/test-sessions", { assessment_id: id, duration_minutes: 240 });
  const code = s.code ?? s.test_session?.code ?? s.session?.code;
  out.push(`${b.title}\t${id}\t${code}`);
}
await Bun.write(
  `${outDir}/student-token.txt`,
  await mintSessionJWT({
    sub: `dev-mint-${student.email.split("@")[0]}`,
    role: "student",
    email: student.email,
    hd: student.email.split("@")[1],
  }),
);
console.log(out.join("\n"));
console.log(`student token (${student.first_name}) → ${outDir}/student-token.txt`);
