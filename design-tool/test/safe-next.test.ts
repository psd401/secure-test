import { describe, expect, test } from "bun:test";
import { safeNextPath } from "../lib/auth/safeNext";

const ORIGIN = "https://design-tool.example.com";

/** What the callback route ultimately does with the accepted value. */
function resolveLikeCallback(next: string | undefined): string {
  return new URL(next ?? "/dashboard", ORIGIN).href;
}

describe("safeNextPath", () => {
  test("accepts ordinary same-origin paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/dashboard/items?q=1")).toBe("/dashboard/items?q=1");
    expect(safeNextPath("/dashboard#top")).toBe("/dashboard#top");
  });

  test("rejects the backslash open redirect (A1)", () => {
    // new URL("/\\evil.com", origin).href === "https://evil.com/"
    expect(safeNextPath("/\\evil.com")).toBeUndefined();
    expect(safeNextPath("/\\/evil.com")).toBeUndefined();
    expect(safeNextPath("\\\\evil.com")).toBeUndefined();
  });

  test("rejects protocol-relative and absolute URLs", () => {
    expect(safeNextPath("//evil.com")).toBeUndefined();
    expect(safeNextPath("https://evil.com")).toBeUndefined();
    expect(safeNextPath("javascript:alert(1)")).toBeUndefined();
  });

  test("rejects control characters the URL parser would strip", () => {
    expect(safeNextPath("/\t/evil.com")).toBeUndefined();
    expect(safeNextPath("/\n\\evil.com")).toBeUndefined();
    expect(safeNextPath(" /dashboard")).toBeUndefined();
  });

  test("rejects empty and missing values", () => {
    expect(safeNextPath(null)).toBeUndefined();
    expect(safeNextPath(undefined)).toBeUndefined();
    expect(safeNextPath("")).toBeUndefined();
  });

  test("every accepted value resolves back onto the app origin", () => {
    const candidates = [
      "/dashboard",
      "/\\evil.com",
      "//evil.com",
      "/dashboard/items?next=//evil.com",
      "https://evil.com",
      "/\t/evil.com",
    ];
    for (const candidate of candidates) {
      const accepted = safeNextPath(candidate);
      expect(new URL(resolveLikeCallback(accepted)).origin).toBe(ORIGIN);
    }
  });
});
