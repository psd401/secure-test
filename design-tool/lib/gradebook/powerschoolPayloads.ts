// PowerTeacher Pro (/ws/xte/) request bodies and response readers, built
// against the shapes read from the test server in slice 2a
// (docs/gradebook-push-design.md §Progress "2026-09-28 — slice 2a"):
//
//   - list responses are plain arrays, no wrapper;
//   - a category is `_name: "teachercategory"` with id `teachercategoryid`,
//     `isactive`, `districtteachercategoryid` on district copies and
//     `defaultpublishoption` and `isdefaultpublishscores`;
//   - an assignment is `_name: "assignment"` with one `_assignmentsections[]`
//     entry per section (ours always one — D-1), each carrying
//     `_assignmentcategoryassociations[]`;
//   - dates are `YYYY-MM-DD`; on a points row `totalpointvalue` =
//     `scoreentrypoints` × `weight`.
//
// The SCORE body is not here: it has not been confirmed live, so it lives on
// its own in `powerschoolScoreBodyUnconfirmed.ts` where slice 2c can change it
// without touching anything confirmed.

/** A PowerTeacher Pro category, normalised: ids as strings. */
export interface PsCategory {
  id: string;
  name: string;
  categorytype: string | null;
  /** 1–4 on the district copies (Classwork, Test, Project, Quiz); else null. */
  districtteachercategoryid: number | null;
  isactive: boolean;
  defaultpublishoption: string | null;
  /** Whether a new assignment in this category publishes its scores; null when the row has no value. */
  isdefaultpublishscores: boolean | null;
}

/** District "Test" (D-6). */
export const DISTRICT_TEST_CATEGORY_ID = 2;

/** PowerTeacher Pro's assignment-name limit (the note: 50, to confirm). */
export const ASSIGNMENT_NAME_MAX = 50;

function asIdString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function asBool(value: unknown): boolean {
  // PowerSchool has been seen to send booleans; a 0/1 or "true"/"1" from an
  // older table view reads the same.
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * An id we hold as text (roster DCIDs, category ids) as PowerSchool wants it
 * in a body: a JSON number when it is all digits, which every PowerSchool
 * DCID is; otherwise the string, untouched.
 */
export function psId(value: string): number | string {
  return /^\d{1,15}$/.test(value) ? Number(value) : value;
}

/** `GET /ws/xte/teacher_category` → every category, normalised. */
export function parseCategories(body: unknown): PsCategory[] {
  if (!Array.isArray(body)) return [];
  const out: PsCategory[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = asIdString(row.teachercategoryid);
    if (!id) continue;
    const district = row.districtteachercategoryid;
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : "",
      categorytype: typeof row.categorytype === "string" ? row.categorytype : null,
      districtteachercategoryid:
        typeof district === "number"
          ? district
          : typeof district === "string" && /^\d+$/.test(district)
            ? Number(district)
            : null,
      isactive: asBool(row.isactive),
      defaultpublishoption:
        typeof row.defaultpublishoption === "string" ? row.defaultpublishoption : null,
      isdefaultpublishscores:
        row.isdefaultpublishscores === undefined || row.isdefaultpublishscores === null
          ? null
          : asBool(row.isdefaultpublishscores),
    });
  }
  return out;
}

/** The dialog lists active categories only, alphabetically. */
export function activeCategories(all: readonly PsCategory[]): PsCategory[] {
  return all
    .filter((c) => c.isactive)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * D-6 (revised 2026-09-28): the teacher's ACTIVE copy of district "Test", else
 * null — no first-active fallback, because a teacher whose four district
 * copies are inactive would otherwise get an unrelated category preselected.
 */
export function defaultCategoryId(all: readonly PsCategory[]): string | null {
  const test = all.find(
    (c) => c.isactive && c.districtteachercategoryid === DISTRICT_TEST_CATEGORY_ID,
  );
  return test ? test.id : null;
}

/** Names over the limit are cut, not refused (the teacher can rename in PTP). */
export function truncateAssignmentName(name: string): string {
  const trimmed = name.trim();
  return [...trimmed].length <= ASSIGNMENT_NAME_MAX
    ? trimmed
    : [...trimmed].slice(0, ASSIGNMENT_NAME_MAX).join("").trimEnd();
}

export interface AssignmentCreateInput {
  sectionDcid: string;
  name: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  maxPoints: number;
  categoryId: string;
  /** The category's `defaultpublishoption` (8.2); omitted when it has none. */
  publishOption: string | null;
  /**
   * The category's `isdefaultpublishscores`, sent as `isscorespublish`;
   * omitted when it has none. PowerTeacher Pro's own create form copies it,
   * but an API create without it leaves Publish Scores off (beta report
   * 2026-10-20: students saw "not scored").
   */
  publishScores: boolean | null;
}

/**
 * `POST /ws/xte/section/assignment/?users_dcid=…` — one section (D-1),
 * points only (D-4): `scoreentrypoints` = `totalpointvalue` = the
 * assessment's `max_points`, `weight` 1.
 */
export function buildAssignmentCreateBody(input: AssignmentCreateInput): Record<string, unknown> {
  const section: Record<string, unknown> = {
    sectionsdcid: psId(input.sectionDcid),
    name: truncateAssignmentName(input.name),
    duedate: input.dueDate,
    scoretype: "POINTS",
    scoreentrypoints: input.maxPoints,
    totalpointvalue: input.maxPoints,
    weight: 1,
    iscountedinfinalgrade: true,
    isscoringneeded: true,
    _assignmentcategoryassociations: [
      { teachercategoryid: psId(input.categoryId), isprimary: true },
    ],
  };
  if (input.publishOption) section.publishoption = input.publishOption;
  if (input.publishScores !== null) section.isscorespublish = input.publishScores;
  return { _assignmentsections: [section] };
}

/**
 * The ids of a created assignment, from the create's 201 or from a GET of the
 * assignment. Measured on the test server 2026-09-29: the 201 has an EMPTY
 * body and a `Location` ending in the `assignmentid` — NOT the
 * `assignmentsectionid` the score write needs (sending that one answered 403
 * "User does not teach section…"). So a trailing Location number is only ever
 * the `assignmentid`; the section id comes from a body (an echoed assignment's
 * first section, or a top-level field), and the live client GETs the
 * assignment to read it when the 201 carries none.
 */
export function parseCreatedAssignment(
  body: unknown,
  location: string | null,
): { assignmentId: string | null; assignmentSectionId: string | null } {
  let assignmentId: string | null = null;
  let assignmentSectionId: string | null = null;
  // A GET may answer the assignment inside an array.
  const row = Array.isArray(body) ? body[0] : body;
  if (row && typeof row === "object") {
    const r = row as Record<string, unknown>;
    assignmentId = asIdString(r.assignmentid);
    const sections = r._assignmentsections;
    if (Array.isArray(sections) && sections[0] && typeof sections[0] === "object") {
      assignmentSectionId = asIdString((sections[0] as Record<string, unknown>).assignmentsectionid);
    }
    assignmentSectionId ??= asIdString(r.assignmentsectionid);
  }
  if (!assignmentId && location) {
    const match = /(\d+)\/?$/.exec(location);
    if (match) assignmentId = match[1]!;
  }
  return { assignmentId, assignmentSectionId };
}

/**
 * `GET /ws/xte/section/assignment/?users_dcid=…&section_ids=<dcid>` → every
 * `assignmentsectionid` in the section. Measured on the test server
 * 2026-09-29: a plain array (no paging; `pagesize` is ignored), one entry per
 * assignment, the id a NUMBER at `_assignmentsections[].assignmentsectionid`.
 * Null when the body is not an array — an unreadable list must never read as
 * "the assignment is gone" (that would archive the push and duplicate it).
 */
export interface PsSectionAssignment {
  assignmentSectionId: string;
  /** What the assignment GET / PUT take; null when the row had none. */
  assignmentId: string | null;
  /** Publish Scores on this section row; null when the row had no value. */
  isScoresPublish: boolean | null;
}

function optionalBool(value: unknown): boolean | null {
  return value === undefined || value === null ? null : asBool(value);
}

/**
 * `GET /ws/xte/section/assignment/?section_ids=…` → one row per assignment
 * section; null when the body is not an array (an unreadable list must never
 * read as "deleted" — GB-2).
 */
export function parseSectionAssignments(body: unknown): PsSectionAssignment[] | null {
  if (!Array.isArray(body)) return null;
  const rows: PsSectionAssignment[] = [];
  for (const a of body) {
    if (!a || typeof a !== "object") continue;
    const assignment = a as Record<string, unknown>;
    const sections = assignment._assignmentsections;
    if (!Array.isArray(sections)) continue;
    for (const s of sections) {
      if (!s || typeof s !== "object") continue;
      const section = s as Record<string, unknown>;
      const id = asIdString(section.assignmentsectionid);
      if (!id) continue;
      rows.push({
        assignmentSectionId: id,
        assignmentId: asIdString(assignment.assignmentid),
        isScoresPublish: optionalBool(section.isscorespublish),
      });
    }
  }
  return rows;
}

/** A single assignment read: the object itself, or the first of an array. */
function assignmentObject(body: unknown): Record<string, unknown> | null {
  const row = Array.isArray(body) ? body[0] : body;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

/**
 * The `PUT /ws/xte/section/assignment/<assignmentid>` body that turns Publish
 * Scores on (slice 2, 2026-10-21): the assignment exactly as PowerSchool
 * answered it, with only our section row's `isscorespublish` set — echoed
 * whole because a partial PUT might clear what it leaves out. Null when the
 * read carries no row for that section. Not yet run against PowerSchool.
 */
export function buildPublishScoresUpdateBody(
  assignment: unknown,
  assignmentSectionId: string,
): Record<string, unknown> | null {
  const obj = assignmentObject(assignment);
  if (!obj || !Array.isArray(obj._assignmentsections)) return null;
  let found = false;
  const sections = obj._assignmentsections.map((s) => {
    if (!s || typeof s !== "object") return s;
    const section = s as Record<string, unknown>;
    if (asIdString(section.assignmentsectionid) !== assignmentSectionId) return section;
    found = true;
    return { ...section, isscorespublish: true };
  });
  return found ? { ...obj, _assignmentsections: sections } : null;
}

/**
 * The fields that differ between two reads of one assignment, other than
 * `isscorespublish` — names only (`_assignmentsections.duedate`), never
 * values, so a PUT that changed more than asked is visible in the log.
 */
export function changedAssignmentFields(before: unknown, after: unknown): string[] {
  const a = assignmentObject(before) ?? {};
  const b = assignmentObject(after) ?? {};
  const changed = new Set<string>();
  const compare = (x: Record<string, unknown>, y: Record<string, unknown>, prefix: string) => {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (key === "isscorespublish" || key === "_assignmentsections") continue;
      if (JSON.stringify(x[key]) !== JSON.stringify(y[key])) changed.add(prefix + key);
    }
  };
  compare(a, b, "");
  const sa = Array.isArray(a._assignmentsections) ? a._assignmentsections : [];
  const sb = Array.isArray(b._assignmentsections) ? b._assignmentsections : [];
  if (sa.length !== sb.length) changed.add("_assignmentsections");
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const x = sa[i], y = sb[i];
    if (x && y && typeof x === "object" && typeof y === "object") {
      compare(x as Record<string, unknown>, y as Record<string, unknown>, "_assignmentsections.");
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      changed.add("_assignmentsections");
    }
  }
  return [...changed].sort();
}

/** The Publish Scores value on our section row of an assignment read. */
export function sectionScoresPublished(assignment: unknown, assignmentSectionId: string): boolean | null {
  const obj = assignmentObject(assignment);
  const sections = obj && Array.isArray(obj._assignmentsections) ? obj._assignmentsections : [];
  for (const s of sections) {
    if (!s || typeof s !== "object") continue;
    const section = s as Record<string, unknown>;
    if (asIdString(section.assignmentsectionid) === assignmentSectionId) return optionalBool(section.isscorespublish);
  }
  return null;
}

/**
 * A score write to an assignment deleted in PowerTeacher Pro. Measured on the
 * test server 2026-09-29: HTTP 500 {"message":"Unable to find
 * com.pearson.powerschool.xte.model.AssignmentSection with id …"}, not a 404.
 * A 404 is accepted too.
 */
export function isAssignmentSectionMissing(status: number, body: string): boolean {
  if (status === 404) return true;
  return status === 500 && /Unable to find [\w.]*AssignmentSection with id/.test(body);
}

/**
 * The students a 409 score write names as not on the assignment. Measured on
 * the test server 2026-09-29: ONE such row refuses the WHOLE batch (nothing
 * written) with errors[].params { assignment_section_id, student_dcid } and a
 * field "Student.id [n] does not have an AssignmentStudentAssociation …".
 * Empty when the body is anything else.
 */
export function parseUnassociatedStudents(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const errors = (parsed as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  const out: string[] = [];
  for (const e of errors) {
    if (!e || typeof e !== "object") continue;
    const field = (e as { field?: unknown }).field;
    const params = (e as { params?: unknown }).params as Record<string, unknown> | undefined;
    const dcid = asIdString(params?.student_dcid);
    if (dcid && typeof field === "string" && field.includes("AssignmentStudentAssociation")) out.push(dcid);
  }
  return out;
}
