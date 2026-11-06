// `/admin/usage` page gate: the same rule as `/admin` — signed out goes to
// login, a non-admin (or an admin acting as someone) gets a 404 rather than a
// "Forbidden" that would reveal the page exists, and an admin sees the table.
// The counts themselves are covered in admin-teacher-usage.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb } from "../db/client";
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

async function digestOf(searchParams: Record<string, string> = {}): Promise<string> {
  try {
    await AdminUsagePage({ searchParams: Promise.resolve(searchParams) });
  } catch (err) {
    return String((err as { digest?: string }).digest ?? "");
  }
  return "";
}

describe("/admin/usage gate", () => {
  test("signed out redirects to login, back to this page", async () => {
    const digest = await digestOf();
    expect(digest).toContain("NEXT_REDIRECT");
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
});
