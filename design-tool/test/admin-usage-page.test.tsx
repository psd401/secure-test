// `/admin/usage` page gate: the same rule as `/admin` — signed out goes to
// login, a non-admin (or an admin acting as someone) gets a 404 rather than a
// "Forbidden" that would reveal the page exists, and an admin sees the table.
// The counts themselves are covered in admin-teacher-usage.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { inArray } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { staffPrincipal } from "./helpers/roster";

const ADMIN_EMAIL = "usage.admin@psd401.net";

type Principal = { sub: string; role: string; email?: string; actor_sub?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
  readStaffSessionFromCookies: async () =>
    principal && principal.role === "staff" ? principal : null,
}));

const { default: AdminUsagePage } = await import("../app/admin/usage/page");

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`admin-usage-page tests require the test DB; got: ${url}`);
  }
});

afterEach(() => {
  principal = null;
  delete process.env.ADMIN_EMAILS;
});

afterAll(async () => {
  await closeDb();
});

// Next's redirect()/notFound() throw an error whose `digest` names the
// outcome. In the full suite, other files (owner-email-heal, start-screen)
// replace `redirect` process-wide with one that throws a plain Error whose
// message is "redirect <url>" — so fall back to the message.
async function digestOf(searchParams: Record<string, string> = {}): Promise<string> {
  try {
    await AdminUsagePage({ searchParams: Promise.resolve(searchParams) });
  } catch (err) {
    const e = err as { digest?: string; message?: string };
    return String(e.digest || e.message || "");
  }
  return "";
}

describe("/admin/usage gate", () => {
  test("signed out redirects to login, back to this page", async () => {
    const digest = await digestOf();
    expect(digest).toMatch(/NEXT_REDIRECT|^redirect /);
    expect(digest).toContain("/login?next=/admin/usage");
  });

  test("a teacher not on ADMIN_EMAILS gets a 404", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    principal = staffPrincipal("usage-teacher");
    expect(await digestOf()).toContain("404");
  });

  test("an admin acting as a teacher gets a 404", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    principal = { ...staffPrincipal("usage-teacher", ADMIN_EMAIL), actor_sub: "usage-admin" };
    expect(await digestOf()).toContain("404");
  });

  test("an admin sees the page, with the requested window marked and the sort kept", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    principal = staffPrincipal("usage-admin", ADMIN_EMAIL);
    const html = renderToStaticMarkup(
      await AdminUsagePage({ searchParams: Promise.resolve({ sort: "sittings", window: "all" }) }),
    );
    expect(html).toContain("Teacher usage");
    // Empty test DB: the empty state shows, and the window links keep the sort.
    expect(html).toContain('<span aria-current="page" class="font-semibold">All time</span>');
    expect(html).toContain("/admin/usage?sort=sittings&amp;window=30d");
    expect(html).toContain("No activity in this window.");
  });

  describe("search", () => {
    const SUBS = ["usage-page-champ", "usage-page-other"];

    afterEach(async () => {
      await getDb().delete(assessments).where(inArray(assessments.owner_sub, SUBS));
    });

    async function render(q: string): Promise<string> {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL;
      principal = staffPrincipal("usage-admin", ADMIN_EMAIL);
      await getDb().insert(assessments).values([
        { owner_sub: SUBS[0]!, owner_email: "Champ.Teacher@example.org", name: "A", status: "draft" },
        { owner_sub: SUBS[1]!, owner_email: "other@example.org", name: "B", status: "draft" },
      ]);
      return renderToStaticMarkup(
        await AdminUsagePage({ searchParams: Promise.resolve({ sort: "sittings", window: "all", q }) }),
      );
    }

    test("narrows the table, keeps the search in the links, and links to the teacher's assessments", async () => {
      const html = await render("champ");
      expect(html).toContain("/dashboard?all=1&amp;owner=champ.teacher%40example.org");
      expect(html).not.toContain("other@example.org");
      expect(html).toContain("/admin/usage?sort=sittings&amp;window=30d&amp;q=champ");
      expect(html).toContain("/admin/usage?sort=students&amp;window=all&amp;q=champ");
    });

    test("the email cell has no clipping classes and every count header may wrap", async () => {
      const html = await render("champ");
      const emailCell = html.match(/<td[^>]*title="Champ\.Teacher@example\.org"[^>]*>/)?.[0];
      expect(emailCell).toBeDefined();
      expect(emailCell).not.toContain("max-w-0");
      expect(emailCell).not.toContain("truncate");

      // Every header but the first (Teacher): the ten counts and Last active.
      const countHeaders = [...html.matchAll(/<th\b[^>]*>/g)].map((m) => m[0]).slice(1);
      expect(countHeaders).toHaveLength(11);
      for (const header of countHeaders) expect(header).toContain("whitespace-normal");
    });

    test("no match says so", async () => {
      expect(await render("nobody-here")).toContain("No teachers match.");
    });
  });
});
