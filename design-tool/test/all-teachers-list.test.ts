// Admin "All teachers" list: URL-carried search, filters and sort
// (lib/ui/allTeachersList.ts). Pure functions, no DOM or database.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ALL_LIST_PARAMS,
  allListQueryEntries,
  filterAndSortAllList,
  hasActiveFilters,
  nextSort,
  ownerOptions,
  parseAllListParams,
  type AllListRow,
} from "../lib/ui/allTeachersList";

function row(over: Partial<AllListRow> & { id: string }): AllListRow {
  return {
    name: over.id,
    owner_email: "a@example.org",
    status: "draft",
    questions: 0,
    students: 0,
    submitted: 0,
    created_at: new Date("2026-09-01T00:00:00Z"),
    updated_at: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

const rows: AllListRow[] = [
  row({ id: "1", name: "Fractions quiz", owner_email: "b@example.org", status: "published", students: 30, submitted: 28, questions: 10, updated_at: new Date("2026-10-01T00:00:00Z") }),
  row({ id: "2", name: "Cell biology", owner_email: "A@example.org", status: "draft", questions: 4, updated_at: new Date("2026-10-03T00:00:00Z") }),
  row({ id: "3", name: "Algebra unit test", owner_email: "c@example.org", status: "published", students: 120, submitted: 110, questions: 25, updated_at: new Date("2026-10-02T00:00:00Z") }),
  row({ id: "4", name: "Orphan", owner_email: null }),
];

const ids = (rs: AllListRow[]) => rs.map((r) => r.id);

describe("parseAllListParams", () => {
  test("empty params are the defaults", () => {
    expect(parseAllListParams({})).toEqual(DEFAULT_ALL_LIST_PARAMS);
  });

  test("bad values fall back rather than throw", () => {
    const p = parseAllListParams({ sort: "drop table", dir: "sideways", status: "x", attempts: "maybe" });
    expect(p).toEqual(DEFAULT_ALL_LIST_PARAMS);
  });

  test("a sort with no dir takes that column's default direction", () => {
    expect(parseAllListParams({ sort: "name" }).dir).toBe("asc");
    expect(parseAllListParams({ sort: "students" }).dir).toBe("desc");
  });

  test("trims the search, lower-cases the owner", () => {
    const p = parseAllListParams({ q: "  quiz ", owner: " B@Example.org " });
    expect(p.q).toBe("quiz");
    expect(p.owner).toBe("b@example.org");
  });
});

describe("filterAndSortAllList", () => {
  test("default is newest-updated first", () => {
    expect(ids(filterAndSortAllList(rows, DEFAULT_ALL_LIST_PARAMS))).toEqual(["2", "3", "1", "4"]);
  });

  test("search matches name or owner, case-insensitively", () => {
    const p = { ...DEFAULT_ALL_LIST_PARAMS };
    expect(ids(filterAndSortAllList(rows, { ...p, q: "QUIZ" }))).toEqual(["1"]);
    expect(ids(filterAndSortAllList(rows, { ...p, q: "c@example" }))).toEqual(["3"]);
  });

  test("owner filter is exact and ignores case in stored emails", () => {
    expect(ids(filterAndSortAllList(rows, { ...DEFAULT_ALL_LIST_PARAMS, owner: "a@example.org" }))).toEqual(["2"]);
  });

  test("status and attempts filters", () => {
    const p = DEFAULT_ALL_LIST_PARAMS;
    expect(ids(filterAndSortAllList(rows, { ...p, status: "published" }))).toEqual(["3", "1"]);
    expect(ids(filterAndSortAllList(rows, { ...p, attempts: "yes" }))).toEqual(["3", "1"]);
    expect(ids(filterAndSortAllList(rows, { ...p, attempts: "no" }))).toEqual(["2", "4"]);
  });

  test("sorts by students descending and by name ascending", () => {
    const p = DEFAULT_ALL_LIST_PARAMS;
    expect(ids(filterAndSortAllList(rows, { ...p, sort: "students", dir: "desc" }))).toEqual(["3", "1", "2", "4"]);
    expect(ids(filterAndSortAllList(rows, { ...p, sort: "name", dir: "asc" }))).toEqual(["3", "2", "1", "4"]);
  });

  test("a missing owner sorts first ascending", () => {
    expect(ids(filterAndSortAllList(rows, { ...DEFAULT_ALL_LIST_PARAMS, sort: "owner", dir: "asc" }))).toEqual(["4", "2", "1", "3"]);
  });

  test("does not mutate the input", () => {
    const copy = [...rows];
    filterAndSortAllList(rows, { ...DEFAULT_ALL_LIST_PARAMS, sort: "name", dir: "asc" });
    expect(rows).toEqual(copy);
  });
});

describe("helpers", () => {
  test("ownerOptions: distinct, lower-cased, sorted, nulls dropped", () => {
    expect(ownerOptions(rows)).toEqual(["a@example.org", "b@example.org", "c@example.org"]);
  });

  test("nextSort flips the same column and starts a new one at its default", () => {
    const p = DEFAULT_ALL_LIST_PARAMS;
    expect(nextSort(p, "updated")).toMatchObject({ sort: "updated", dir: "asc" });
    expect(nextSort(p, "name")).toMatchObject({ sort: "name", dir: "asc" });
    expect(nextSort({ ...p, sort: "name", dir: "asc" }, "name")).toMatchObject({ dir: "desc" });
  });

  test("allListQueryEntries omits defaults and round-trips through parse", () => {
    expect(allListQueryEntries(DEFAULT_ALL_LIST_PARAMS)).toEqual([]);
    const p = { ...DEFAULT_ALL_LIST_PARAMS, q: "quiz", status: "published", attempts: "yes" as const, sort: "students" as const };
    const back = parseAllListParams(Object.fromEntries(allListQueryEntries(p)));
    expect(back).toEqual(p);
  });

  test("hasActiveFilters ignores sort", () => {
    expect(hasActiveFilters({ ...DEFAULT_ALL_LIST_PARAMS, sort: "name" })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_ALL_LIST_PARAMS, attempts: "no" })).toBe(true);
  });
});
