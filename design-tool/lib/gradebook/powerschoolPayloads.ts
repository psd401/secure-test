// PowerTeacher Pro (/ws/xte/) request bodies and response readers, built
// against the shapes read from the test server in slice 2a
// (docs/gradebook-push-design.md §Progress "2026-09-28 — slice 2a"):
//
//   - list responses are plain arrays, no wrapper;
//   - a category is `_name: "teachercategory"` with id `teachercategoryid`,
//     `isactive`, `districtteachercategoryid` on district copies and
//     `defaultpublishoption`;
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
  return { _assignmentsections: [section] };
}

/**
 * The created assignment's `assignmentsectionid` from a 201. The body shape
 * is not yet read live (slice 2c's first write), so this accepts the three
 * plausible places: the echoed assignment's first section, a top-level field,
 * or the trailing number of a `Location` header. Null when none carries it.
 */
export function parseCreatedAssignmentSectionId(
  body: unknown,
  location: string | null,
): string | null {
  if (body && typeof body === "object") {
    const row = body as Record<string, unknown>;
    const sections = row._assignmentsections;
    if (Array.isArray(sections) && sections[0] && typeof sections[0] === "object") {
      const id = asIdString((sections[0] as Record<string, unknown>).assignmentsectionid);
      if (id) return id;
    }
    const top = asIdString(row.assignmentsectionid);
    if (top) return top;
  }
  if (location) {
    const match = /(\d+)\/?$/.exec(location);
    if (match) return match[1]!;
  }
  return null;
}
