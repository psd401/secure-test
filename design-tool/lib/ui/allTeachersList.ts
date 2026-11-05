/**
 * The admin "All teachers" list (/dashboard?all=1): search, filters and sort,
 * all carried in the URL so a filtered view can be bookmarked or shared. The
 * page is a server component, so the list is filtered and sorted on the
 * server from these params; every function here is pure so it is testable
 * without a DOM or a database.
 */

export const ALL_LIST_SORT_KEYS = [
  "name",
  "owner",
  "status",
  "questions",
  "students",
  "submitted",
  "created",
  "updated",
] as const;
export type AllListSortKey = (typeof ALL_LIST_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export interface AllListParams {
  /** Free-text search over assessment name and owner email. */
  q: string;
  /** Exact owner email (lower-cased), or "" for every owner. */
  owner: string;
  /** "draft" | "published", or "" for both. */
  status: string;
  /** "yes" = at least one student attempt, "no" = none, "" = either. */
  attempts: "" | "yes" | "no";
  sort: AllListSortKey;
  dir: SortDir;
}

export const DEFAULT_ALL_LIST_PARAMS: AllListParams = {
  q: "",
  owner: "",
  status: "",
  attempts: "",
  sort: "updated",
  dir: "desc",
};

/** Text columns sort A→Z first; numbers and dates sort biggest/newest first. */
export function defaultDir(key: AllListSortKey): SortDir {
  return key === "name" || key === "owner" || key === "status" ? "asc" : "desc";
}

/** Unknown or malformed values fall back to the defaults, never throw. */
export function parseAllListParams(sp: Record<string, string | undefined>): AllListParams {
  const sort = (ALL_LIST_SORT_KEYS as readonly string[]).includes(sp.sort ?? "")
    ? (sp.sort as AllListSortKey)
    : DEFAULT_ALL_LIST_PARAMS.sort;
  const dir: SortDir =
    sp.dir === "asc" || sp.dir === "desc"
      ? sp.dir
      : sp.sort === sort
        ? defaultDir(sort)
        : DEFAULT_ALL_LIST_PARAMS.dir;
  return {
    q: (sp.q ?? "").trim().slice(0, 200),
    owner: (sp.owner ?? "").trim().toLowerCase(),
    status: sp.status === "draft" || sp.status === "published" ? sp.status : "",
    attempts: sp.attempts === "yes" || sp.attempts === "no" ? sp.attempts : "",
    sort,
    dir,
  };
}

export interface AllListRow {
  id: string;
  name: string;
  owner_email: string | null;
  status: string;
  questions: number;
  /** Distinct students with at least one attempt on this assessment. */
  students: number;
  /** Submitted attempts. */
  submitted: number;
  created_at: Date;
  updated_at: Date;
}

function sortValue(r: AllListRow, key: AllListSortKey): string | number {
  switch (key) {
    case "name":
      return r.name.toLowerCase();
    case "owner":
      return (r.owner_email ?? "").toLowerCase();
    case "status":
      return r.status;
    case "questions":
      return r.questions;
    case "students":
      return r.students;
    case "submitted":
      return r.submitted;
    case "created":
      return r.created_at.getTime();
    case "updated":
      return r.updated_at.getTime();
  }
}

export function filterAndSortAllList<T extends AllListRow>(rows: T[], p: AllListParams): T[] {
  const q = p.q.toLowerCase();
  const out = rows.filter((r) => {
    const owner = (r.owner_email ?? "").toLowerCase();
    if (q && !r.name.toLowerCase().includes(q) && !owner.includes(q)) return false;
    if (p.owner && owner !== p.owner) return false;
    if (p.status && r.status !== p.status) return false;
    if (p.attempts === "yes" && r.students === 0) return false;
    if (p.attempts === "no" && r.students > 0) return false;
    return true;
  });
  const sign = p.dir === "asc" ? 1 : -1;
  // Ties fall back to newest-updated, so equal counts keep a stable order.
  return out.sort((a, b) => {
    const va = sortValue(a, p.sort);
    const vb = sortValue(b, p.sort);
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return b.updated_at.getTime() - a.updated_at.getTime();
  });
}

/** Distinct owner emails for the Owner filter, A→Z. */
export function ownerOptions(rows: Pick<AllListRow, "owner_email">[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.owner_email) set.add(r.owner_email.toLowerCase());
  return [...set].sort();
}

/**
 * The list params as query entries, defaults omitted so the URL stays short.
 * The page adds `all` / `archived` around these.
 */
export function allListQueryEntries(p: AllListParams): [string, string][] {
  const out: [string, string][] = [];
  if (p.q) out.push(["q", p.q]);
  if (p.owner) out.push(["owner", p.owner]);
  if (p.status) out.push(["status", p.status]);
  if (p.attempts) out.push(["attempts", p.attempts]);
  if (p.sort !== DEFAULT_ALL_LIST_PARAMS.sort || p.dir !== DEFAULT_ALL_LIST_PARAMS.dir) {
    out.push(["sort", p.sort]);
    out.push(["dir", p.dir]);
  }
  return out;
}

/** The params a column header's link should carry: same column flips, a new one starts at its default. */
export function nextSort(p: AllListParams, key: AllListSortKey): AllListParams {
  const dir = p.sort === key ? (p.dir === "asc" ? "desc" : "asc") : defaultDir(key);
  return { ...p, sort: key, dir };
}

export function hasActiveFilters(p: AllListParams): boolean {
  return Boolean(p.q || p.owner || p.status || p.attempts);
}

/* ---------- "By teacher" summary (/dashboard?all=1&view=teachers) ---------- */

export const TEACHER_SORT_KEYS = [
  "teacher",
  "assessments",
  "published",
  "sittings",
  "students",
  "submitted",
  "last",
] as const;
export type TeacherSortKey = (typeof TEACHER_SORT_KEYS)[number];

export interface TeacherParams {
  /** Free-text search over the teacher's email. */
  q: string;
  sort: TeacherSortKey;
  dir: SortDir;
}

/** Busiest first: the summary exists to find who has the most students. */
export const DEFAULT_TEACHER_PARAMS: TeacherParams = { q: "", sort: "students", dir: "desc" };

export function teacherDefaultDir(key: TeacherSortKey): SortDir {
  return key === "teacher" ? "asc" : "desc";
}

export function parseTeacherParams(sp: Record<string, string | undefined>): TeacherParams {
  const known = (TEACHER_SORT_KEYS as readonly string[]).includes(sp.sort ?? "");
  const sort = known ? (sp.sort as TeacherSortKey) : DEFAULT_TEACHER_PARAMS.sort;
  const dir: SortDir =
    sp.dir === "asc" || sp.dir === "desc"
      ? sp.dir
      : known
        ? teacherDefaultDir(sort)
        : DEFAULT_TEACHER_PARAMS.dir;
  return { q: (sp.q ?? "").trim().slice(0, 200), sort, dir };
}

export interface TeacherRowLike {
  owner_sub: string;
  owner_email: string | null;
  assessments: number;
  published: number;
  sittings: number;
  students: number;
  submitted: number;
  last_activity: Date | null;
}

function teacherSortValue(r: TeacherRowLike, key: TeacherSortKey): string | number {
  switch (key) {
    case "teacher":
      return (r.owner_email ?? r.owner_sub).toLowerCase();
    case "last":
      return r.last_activity?.getTime() ?? 0;
    default:
      return r[key];
  }
}

export function filterAndSortTeachers<T extends TeacherRowLike>(rows: T[], p: TeacherParams): T[] {
  const q = p.q.toLowerCase();
  const out = rows.filter((r) => !q || (r.owner_email ?? "").toLowerCase().includes(q));
  const sign = p.dir === "asc" ? 1 : -1;
  // Ties fall back to the email A→Z so the order is stable.
  return out.sort((a, b) => {
    const va = teacherSortValue(a, p.sort);
    const vb = teacherSortValue(b, p.sort);
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return (a.owner_email ?? a.owner_sub).localeCompare(b.owner_email ?? b.owner_sub);
  });
}

export function nextTeacherSort(p: TeacherParams, key: TeacherSortKey): TeacherParams {
  const dir = p.sort === key ? (p.dir === "asc" ? "desc" : "asc") : teacherDefaultDir(key);
  return { ...p, sort: key, dir };
}

/** `/dashboard?all=1&view=teachers` plus the non-default params. */
export function teachersHref(p: TeacherParams): string {
  const qs = new URLSearchParams({ all: "1", view: "teachers" });
  if (p.q) qs.set("q", p.q);
  if (p.sort !== DEFAULT_TEACHER_PARAMS.sort || p.dir !== DEFAULT_TEACHER_PARAMS.dir) {
    qs.set("sort", p.sort);
    qs.set("dir", p.dir);
  }
  return `/dashboard?${qs.toString()}`;
}
