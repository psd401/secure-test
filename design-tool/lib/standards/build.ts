// Pure transform from OSPI's two 2026 adoption workbooks to the catalog and
// crosswalk JSON (docs/batch-item-generation-design.md §Catalog sources). The
// script scripts/build-standards.ts is a thin wrapper that reads the files,
// checks their checksums and writes the output; the test re-runs this in
// memory and compares it to the committed JSON.
import ExcelJS from "exceljs";
import type { CrosswalkPair, StandardEntry } from "./types";

type Cell = ExcelJS.CellValue;
type Sheet = ExcelJS.Worksheet;

export type StandardsBuild = {
  catalog: StandardEntry[];
  crosswalk: CrosswalkPair[];
};

// ELA domain abbreviations -> the names on the workbook's own "Domains" sheet.
const ELA_DOMAINS: Record<string, string> = {
  R: "Reading",
  W: "Writing",
  SLDF: "Speaking, Listening, and Digital Forums",
  L: "Language",
  RML: "Research and Media Literacy",
};

// CCSS 2010 math domains by the second code segment ("7.RP.A.2" -> RP;
// "HSN.RN.A.1" -> RN). MD means different things in K-8 and high school.
const CCSS_MATH_DOMAINS: Record<string, string> = {
  CC: "Counting and Cardinality",
  OA: "Operations and Algebraic Thinking",
  NBT: "Number and Operations in Base Ten",
  NF: "Number and Operations - Fractions",
  MD: "Measurement and Data",
  G: "Geometry",
  RP: "Ratios and Proportional Relationships",
  NS: "The Number System",
  EE: "Expressions and Equations",
  F: "Functions",
  SP: "Statistics and Probability",
};
const CCSS_HS_DOMAINS: Record<string, string> = {
  RN: "The Real Number System",
  Q: "Quantities",
  CN: "The Complex Number System",
  VM: "Vector and Matrix Quantities",
  SSE: "Seeing Structure in Expressions",
  APR: "Arithmetic with Polynomials and Rational Expressions",
  CED: "Creating Equations",
  REI: "Reasoning with Equations and Inequalities",
  IF: "Interpreting Functions",
  BF: "Building Functions",
  LE: "Linear, Quadratic, and Exponential Models",
  TF: "Trigonometric Functions",
  CO: "Congruence",
  SRT: "Similarity, Right Triangles, and Trigonometry",
  C: "Circles",
  GPE: "Expressing Geometric Properties with Equations",
  GMD: "Geometric Measurement and Dimension",
  MG: "Modeling with Geometry",
  ID: "Interpreting Categorical and Quantitative Data",
  IC: "Making Inferences and Justifying Conclusions",
  CP: "Conditional Probability and the Rules of Probability",
  MDHS: "Using Probability to Make Decisions",
};
// CCSS 2010 ELA strands by the code's first segment.
const CCSS_ELA_DOMAINS: Record<string, string> = {
  RL: "Reading",
  RI: "Reading",
  RF: "Reading",
  W: "Writing",
  SL: "Speaking and Listening",
  L: "Language",
};

// A 2026 code the ELA crosswalk names that the workbook's own standards sheet
// does not define (grade 11-12 Reading has no R.5; six CCSS rows cite it). The
// pairs are dropped rather than guessed at; any other unknown code fails the build.
const UNKNOWN_2026_CODES = new Set(["ELA.11-12.R.5"]);

const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9-10", "11-12", "HS"];

function raw(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as { text: string }[]).map((p) => p.text).join("");
    }
    if ("result" in v) return String(v.result ?? "");
    if ("text" in v) return String(v.text ?? "");
    if (value instanceof Date) return value.toISOString();
    return "";
  }
  return String(value);
}

/** Collapse runs of spaces; keep line breaks (the "a. b. c." sub-items). */
function clean(value: Cell): string {
  return raw(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

const flat = (value: Cell) => clean(value).replace(/\n/g, " ");
const yes = (value: Cell) => flat(value).toLowerCase() === "yes";

function sheet(wb: ExcelJS.Workbook, name: string): Sheet {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`workbook has no sheet "${name}"`);
  return ws;
}

function expectHeader(ws: Sheet, row: number, expected: string[]) {
  const got = expected.map((_, i) => flat(ws.getRow(row).getCell(i + 1).value));
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  expected.forEach((want, i) => {
    if (norm(got[i]!) !== norm(want)) {
      throw new Error(
        `sheet "${ws.name}" row ${row} column ${i + 1}: expected header "${want}", found "${got[i]}"`,
      );
    }
  });
}

function rows(ws: Sheet, first: number): ExcelJS.Row[] {
  const out: ExcelJS.Row[] = [];
  for (let r = first; r <= ws.rowCount; r += 1) out.push(ws.getRow(r));
  return out;
}

const grade = (value: Cell) => flat(value).replace(/_/g, "-");

function ccssMathDomain(code: string): string {
  const parts = code.split(".");
  const hs = parts[0]!.startsWith("HS");
  const seg = parts[1] ?? "";
  const key = hs && seg === "MD" ? "MDHS" : seg;
  const name = (hs ? CCSS_HS_DOMAINS : CCSS_MATH_DOMAINS)[key];
  return name ?? seg;
}

function ccssElaDomain(code: string): string {
  const prefix = code.split(".")[0]!;
  return CCSS_ELA_DOMAINS[prefix] ?? prefix;
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function sortCatalog(entries: StandardEntry[]): StandardEntry[] {
  const schemeRank = { wa2026: 0, ccss2010: 1, ngss: 2 } as const;
  const gradeRank = (g: string) => {
    const i = GRADE_ORDER.indexOf(g);
    return i === -1 ? GRADE_ORDER.length : i;
  };
  return [...entries].sort(
    (a, b) =>
      schemeRank[a.scheme] - schemeRank[b.scheme] ||
      compare(a.subject, b.subject) ||
      gradeRank(a.grade_band) - gradeRank(b.grade_band) ||
      compare(a.code, b.code),
  );
}

/** Insert a key order that never changes between runs. */
function entry(e: StandardEntry): StandardEntry {
  const out: StandardEntry = {
    scheme: e.scheme,
    code: e.code,
    subject: e.subject,
    grade_band: e.grade_band,
    domain: e.domain,
    text: e.text,
  };
  if (e.priority !== undefined) out.priority = e.priority;
  if (e.new_in_2026 !== undefined) out.new_in_2026 = e.new_in_2026;
  if (e.courses) {
    out.courses = e.courses.map((c) =>
      c.text === undefined
        ? { course: c.course, priority: c.priority }
        : { course: c.course, priority: c.priority, text: c.text },
    );
  }
  return out;
}

function addCcss(
  map: Map<string, StandardEntry>,
  e: StandardEntry,
  where: string,
) {
  const have = map.get(e.code);
  if (!have) {
    map.set(e.code, e);
    return;
  }
  if (have.text !== e.text) throw new Error(`${where}: CCSS ${e.code} appears with two different texts`);
}

function mathWa2026(wb: ExcelJS.Workbook): StandardEntry[] {
  const out = new Map<string, StandardEntry>();

  const k8 = sheet(wb, "K-8 and Connections");
  expectHeader(k8, 3, ["Full Code", "Grade Level", "Domain", "2026 Mathematics Standard", "New in 2026", "Priority"]);
  for (const row of rows(k8, 4)) {
    const code = flat(row.getCell(1).value);
    if (!code) continue;
    if (out.has(code)) throw new Error(`math K-8: duplicate code ${code}`);
    out.set(code, {
      scheme: "wa2026",
      code,
      subject: "math",
      grade_band: grade(row.getCell(2).value),
      domain: flat(row.getCell(3).value),
      text: clean(row.getCell(4).value),
      priority: yes(row.getCell(6).value),
      new_in_2026: yes(row.getCell(5).value),
    });
  }

  const hs = sheet(wb, "HS and Connections");
  expectHeader(hs, 3, ["Original Order", "Full Code", "Course", "Domain", "2026 Mathematics Standard", "New in 2026", "Priority in this Course"]);
  for (const row of rows(hs, 4)) {
    const code = flat(row.getCell(2).value);
    if (!code) continue;
    const course = flat(row.getCell(3).value);
    const priority = yes(row.getCell(7).value);
    const text = clean(row.getCell(5).value);
    const have = out.get(code);
    if (!have) {
      out.set(code, {
        scheme: "wa2026",
        code,
        subject: "math",
        grade_band: "HS",
        domain: flat(row.getCell(4).value),
        text,
        priority,
        new_in_2026: yes(row.getCell(6).value),
        courses: [{ course, priority }],
      });
      continue;
    }
    if (have.grade_band !== "HS" || !have.courses) throw new Error(`HS sheet reuses K-8 code ${code}`);
    if (have.courses.some((c) => c.course === course)) throw new Error(`HS sheet: ${code} repeats course ${course}`);
    // 22 HS standards are worded differently per course; the entry keeps the
    // first course's text and a differing course carries its own.
    have.courses.push(have.text === text ? { course, priority } : { course, priority, text });
    have.priority = have.priority || priority;
  }
  return [...out.values()];
}

function elaWa2026(wb: ExcelJS.Workbook): StandardEntry[] {
  const ws = sheet(wb, "ELA26 and Connections");
  expectHeader(ws, 3, ["Original Order", "Full Code", "Grade Level", "Domain", "Number", "2026 English Langage Arts Standard", "New in 2026", "Priority"]);
  const out = new Map<string, StandardEntry>();
  for (const row of rows(ws, 4)) {
    const code = flat(row.getCell(2).value);
    if (!code) continue;
    if (out.has(code)) throw new Error(`ELA: duplicate code ${code}`);
    const abbr = flat(row.getCell(4).value);
    const domain = ELA_DOMAINS[abbr];
    if (!domain) throw new Error(`ELA ${code}: unmapped domain "${abbr}"`);
    out.set(code, {
      scheme: "wa2026",
      code,
      subject: "ela",
      grade_band: grade(row.getCell(3).value),
      domain,
      text: clean(row.getCell(6).value),
      priority: yes(row.getCell(8).value),
      new_in_2026: yes(row.getCell(7).value),
    });
  }
  return [...out.values()];
}

/** The 2026 cell of a crosswalk row can name several codes ("ELA.K.W.1  ELA.K.W.3"). */
function codesOf(value: Cell): string[] {
  return flat(value)
    .replace(/\bELA (?=\d)/g, "ELA.") // OSPI typo: "ELA 11-12.W.3"
    .split(" ")
    .filter((c) => c.length > 0 && c !== "NA");
}

function mathCrosswalk(wb: ExcelJS.Workbook) {
  const ws = sheet(wb, "Crosswalk");
  expectHeader(ws, 4, ["Grade Level", "Common Core Code", "Common Core Standard", "2026 Math Standard Code"]);
  const ccss = new Map<string, StandardEntry>();
  const pairs: CrosswalkPair[] = [];
  for (const row of rows(ws, 5)) {
    const code = flat(row.getCell(2).value);
    if (!code || code === "NA") continue;
    const g = flat(row.getCell(1).value);
    addCcss(
      ccss,
      {
        scheme: "ccss2010",
        code,
        subject: "math",
        grade_band: g.startsWith("HS") ? "HS" : grade(row.getCell(1).value),
        domain: ccssMathDomain(code),
        text: clean(row.getCell(3).value),
      },
      "math crosswalk",
    );
    for (const wa of codesOf(row.getCell(4).value)) pairs.push({ ccss2010: code, wa2026: wa });
  }
  return { ccss: [...ccss.values()], pairs };
}

function elaCrosswalk(wb: ExcelJS.Workbook) {
  const ws = sheet(wb, "Crosswalk");
  expectHeader(ws, 4, ["Grade Level", "Common Core Strand", "Common Core Full Code", "Common Core Standard", "2026 ELA Standard Code"]);
  const ccss = new Map<string, StandardEntry>();
  const pairs: CrosswalkPair[] = [];
  for (const row of rows(ws, 5)) {
    const code = flat(row.getCell(3).value);
    if (!code || code === "NA") continue;
    addCcss(
      ccss,
      {
        scheme: "ccss2010",
        code,
        subject: "ela",
        grade_band: grade(row.getCell(1).value),
        domain: ccssElaDomain(code),
        text: clean(row.getCell(4).value),
      },
      "ELA crosswalk",
    );
    for (const wa of codesOf(row.getCell(5).value)) pairs.push({ ccss2010: code, wa2026: wa });
  }
  return { ccss: [...ccss.values()], pairs };
}

export async function buildStandards(files: {
  math: ArrayBuffer | Uint8Array;
  ela: ArrayBuffer | Uint8Array;
}): Promise<StandardsBuild> {
  const load = async (data: ArrayBuffer | Uint8Array) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as ArrayBuffer);
    return wb;
  };
  const [math, ela] = [await load(files.math), await load(files.ela)];

  const mc = mathCrosswalk(math);
  const ec = elaCrosswalk(ela);
  const catalog = sortCatalog(
    [...mathWa2026(math), ...elaWa2026(ela), ...mc.ccss, ...ec.ccss].map(entry),
  );

  const seen = new Set<string>();
  const crosswalk: CrosswalkPair[] = [];
  for (const p of [...mc.pairs, ...ec.pairs]) {
    const key = `${p.ccss2010}|${p.wa2026}`;
    if (seen.has(key)) continue;
    seen.add(key);
    crosswalk.push({ ccss2010: p.ccss2010, wa2026: p.wa2026 });
  }
  crosswalk.sort((a, b) => compare(a.wa2026, b.wa2026) || compare(a.ccss2010, b.ccss2010));

  const codes = new Set(catalog.map((e) => `${e.scheme}:${e.code}`));
  const kept: CrosswalkPair[] = [];
  for (const p of crosswalk) {
    if (!codes.has(`ccss2010:${p.ccss2010}`)) throw new Error(`crosswalk names unknown CCSS code ${p.ccss2010}`);
    if (!codes.has(`wa2026:${p.wa2026}`)) {
      if (UNKNOWN_2026_CODES.has(p.wa2026)) continue;
      throw new Error(`crosswalk names unknown 2026 code ${p.wa2026}`);
    }
    kept.push(p);
  }
  return { catalog, crosswalk: kept };
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
