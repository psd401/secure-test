// BG slice 2 (docs/batch-item-generation-design.md §Standards tags): the
// picker's search + lookup routes, the pure tag helpers, and the guard that
// keeps the ~990 KB catalog out of every client bundle.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { chipLabel, normalizeStandards, schemeLabel, shortText, tagScheme } from "../lib/standards/tags";
import { lookupTags, resolveBareCode, searchStandards } from "../lib/standards/search";

let mockSession: { sub: string; role: string } | null = { sub: "t", role: "staff" };

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSession && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => mockSession,
}));

type SearchBody = {
  results: {
    tag: string;
    scheme: string;
    code: string;
    subject: string;
    grade_band: string;
    domain: string;
    text: string;
    counterparts: { tag: string; code: string; scheme: string }[];
  }[];
  exact: string | null;
  facets: { grade_bands: Record<string, string[]>; courses: string[] };
};

async function searchRoute(query: string) {
  const { GET } = await import("../app/api/standards/route");
  return GET(new Request(`http://localhost/api/standards?${query}`));
}

async function lookupRoute(query: string) {
  const { GET } = await import("../app/api/standards/lookup/route");
  return GET(new Request(`http://localhost/api/standards/lookup?${query}`));
}

describe("GET /api/standards", () => {
  test("401 without a session, 403 for a student", async () => {
    mockSession = null;
    expect((await searchRoute("q=ratio")).status).toBe(401);
    expect((await lookupRoute("tags=a")).status).toBe(401);
    mockSession = { sub: "s", role: "student" };
    expect((await searchRoute("q=ratio")).status).toBe(403);
    expect((await lookupRoute("tags=a")).status).toBe(403);
    mockSession = { sub: "t", role: "staff" };
  });

  test("a 2011 code finds the CCSS entry with its 2026 counterpart; 2026 preferred lists the 2026 entry first", async () => {
    const res = await searchRoute("q=7.RP.A.2&prefer=wa2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results[0]!.tag).toBe("wa2026:M.7.R.RP.2");
    const ccss = body.results.find((r) => r.tag === "ccss2010:7.RP.A.2")!;
    expect(ccss.counterparts.map((c) => c.tag)).toEqual(["wa2026:M.7.R.RP.2"]);
    expect(body.results[0]!.counterparts.map((c) => c.code)).toContain("7.RP.A.2");
    expect(body.exact).toBe("ccss2010:7.RP.A.2");
  });

  test("2011 preferred puts the CCSS entry first", async () => {
    const body = (await (await searchRoute("q=7.RP.A.2&prefer=ccss2010")).json()) as SearchBody;
    expect(body.results[0]!.tag).toBe("ccss2010:7.RP.A.2");
  });

  test("filters: subject, grade band, scheme, HS course", async () => {
    let body = (await (await searchRoute("q=&subject=science&grade_band=MS&limit=50")).json()) as SearchBody;
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r) => r.scheme === "ngss" && r.grade_band === "MS")).toBe(true);

    body = (await (await searchRoute("subject=math&scheme=ccss2010&grade_band=7")).json()) as SearchBody;
    expect(body.results.every((r) => r.scheme === "ccss2010" && r.grade_band === "7")).toBe(true);

    body = (await (await searchRoute("subject=math&grade_band=HS&course=GEO&limit=50")).json()) as SearchBody;
    const all = searchStandards({ q: "", subject: "math", gradeBand: "HS", limit: 50 });
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r) => r.scheme === "wa2026")).toBe(true);
    expect(body.results.map((r) => r.tag)).not.toEqual(all.map((r) => r.tag));
    expect(body.facets.courses).toContain("GEO");
    expect(body.facets.grade_bands.ela).toContain("9-10");
  });

  test("limit defaults to 20 and caps at 50; a bad parameter is 400", async () => {
    let body = (await (await searchRoute("q=")).json()) as SearchBody;
    expect(body.results.length).toBe(20);
    body = (await (await searchRoute("q=&limit=500")).json()) as SearchBody;
    expect(body.results.length).toBe(50);
    expect((await searchRoute("limit=0")).status).toBe(400);
    expect((await searchRoute("limit=abc")).status).toBe(400);
    expect((await searchRoute("subject=history")).status).toBe(400);
    expect((await searchRoute("prefer=ccss2020")).status).toBe(400);
  });

  test("text search matches across the standard's wording", async () => {
    const body = (await (await searchRoute("q=photosynthesis&subject=science")).json()) as SearchBody;
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.exact).toBeNull();
  });
});

describe("GET /api/standards/lookup", () => {
  test("known tags resolve, custom and unknown tags are null", async () => {
    const res = await lookupRoute(
      `tags=${encodeURIComponent("wa2026:M.7.R.RP.2,Local target,wa2026:NOPE.1")}`,
    );
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: Record<string, { code: string; scheme: string; text: string } | null>;
    };
    expect(entries["wa2026:M.7.R.RP.2"]!.code).toBe("M.7.R.RP.2");
    expect(entries["wa2026:M.7.R.RP.2"]!.text.length).toBeGreaterThan(0);
    expect(entries["Local target"]).toBeNull();
    expect(entries["wa2026:NOPE.1"]).toBeNull();
  });

  test("more than 20 tags → 400", async () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`).join(",");
    expect((await lookupRoute(`tags=${tags}`)).status).toBe(400);
    expect((await lookupRoute("")).status).toBe(200);
  });
});

describe("pure helpers", () => {
  test("normalizeStandards trims, drops empties and dedupes in order", () => {
    expect(normalizeStandards([" a ", "", "b", "a", "  ", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("tagScheme recognizes only shipped schemes", () => {
    expect(tagScheme("wa2026:M.7.R.RP.2")).toBe("wa2026");
    expect(tagScheme("ngss:MS-PS1-2")).toBe("ngss");
    expect(tagScheme("ccss2020:X")).toBeNull();
    expect(tagScheme("Local: target")).toBeNull();
    expect(tagScheme(":x")).toBeNull();
  });

  test("chip label: catalog code + short text, else the tag as typed", () => {
    const label = chipLabel("wa2026:M.7.R.RP.2", { code: "M.7.R.RP.2", text: "x ".repeat(80) });
    expect(label.code).toBe("M.7.R.RP.2");
    expect(label.text!.length).toBeLessThanOrEqual(60);
    expect(label.text!.endsWith("…")).toBe(true);
    expect(label.title.startsWith("M.7.R.RP.2 — ")).toBe(true);
    expect(chipLabel("ccss2020:X.Y", null)).toEqual({ code: "ccss2020:X.Y", text: null, title: "ccss2020:X.Y" });
    expect(shortText("short")).toBe("short");
    expect(schemeLabel("ccss2010")).toBe("2011");
    expect(schemeLabel("wa2026")).toBe("2026");
  });

  test("resolveBareCode: an exact code in exactly one scheme, else null", () => {
    expect(resolveBareCode("7.RP.A.2")).toBe("ccss2010:7.RP.A.2");
    expect(resolveBareCode(" M.7.R.RP.2 ")).toBe("wa2026:M.7.R.RP.2");
    expect(resolveBareCode("MS-PS1-2")).toBe("ngss:MS-PS1-2");
    expect(resolveBareCode("Unit 3 target")).toBeNull();
    expect(lookupTags(["Unit 3 target"])).toEqual({ "Unit 3 target": null });
  });
});

describe("the catalog stays server-only", () => {
  const ROOT = resolve(import.meta.dir, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(ROOT, "app"));
  walk(join(ROOT, "components"));
  walk(join(ROOT, "lib"));

  // Anything that pulls in the JSON: the catalog module, the search shaping on
  // top of it, or the JSON files themselves.
  const CATALOG_IMPORT = /from\s+["'][^"']*standards\/(catalog|search|catalog\.json|crosswalk\.json)["']/;
  const isClient = (src: string) => /^\s*["']use client["']/.test(src);

  test("no 'use client' file imports the catalog", () => {
    const clientFiles = files.filter((f) => isClient(readFileSync(f, "utf8")));
    expect(clientFiles.length).toBeGreaterThan(0);
    const offenders = clientFiles.filter((f) => CATALOG_IMPORT.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the client-safe helpers do not import the catalog either", () => {
    const src = readFileSync(join(ROOT, "lib", "standards", "tags.ts"), "utf8");
    expect(/from\s+["']\.\/(catalog|search)["']/.test(src)).toBe(false);
    expect(src).not.toContain(".json");
  });
});
