// Beta report (2026-10-27): the import page posts the chosen file to
// POST /api/assessments/import from the browser instead of a server action
// (whose 1 MB body cap refused files with large pictures). Pure: the route
// is a stub `fetch`, so no database.
import { describe, expect, test } from "bun:test";
import { importFileDestination } from "../lib/preview/importFile";

function form(bytes = "{}"): FormData {
  const f = new FormData();
  f.set("file", new File([bytes], "a.json", { type: "application/json" }));
  return f;
}

function stub(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("importFileDestination", () => {
  test("a created import goes to the new draft; the file is posted to the import route", async () => {
    const { calls, fetchImpl } = stub(201, { assessment: { id: "abc" } });
    const f = form();
    expect(await importFileDestination(f, fetchImpl)).toBe("/dashboard/abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/assessments/import");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(f);
  });

  test("a file over 1 MB is posted like any other (no server-action cap on this path)", async () => {
    const { calls, fetchImpl } = stub(201, { assessment: { id: "big" } });
    expect(await importFileDestination(form("x".repeat(1_500_000)), fetchImpl)).toBe("/dashboard/big");
    expect((calls[0]!.init?.body as FormData).get("file")).toBeInstanceOf(File);
  });

  test("no file, or an empty one, never calls the route", async () => {
    const { calls, fetchImpl } = stub(201, {});
    expect(await importFileDestination(new FormData(), fetchImpl)).toBe("/dashboard/import?error=no_file_selected");
    expect(await importFileDestination(form(""), fetchImpl)).toBe("/dashboard/import?error=no_file_selected");
    expect(calls).toHaveLength(0);
  });

  test("a refusal comes back as the page's ?error= code", async () => {
    expect(await importFileDestination(form(), stub(413, { ok: false, error: "file_too_large" }).fetchImpl)).toBe(
      "/dashboard/import?error=file_too_large",
    );
    const schema = stub(400, { ok: false, error: "schema_invalid", detail: [{ path: ["items", 0], message: "bad" }] });
    expect(await importFileDestination(form(), schema.fetchImpl)).toBe(
      `/dashboard/import?error=${encodeURIComponent("schema_invalid:items.0:bad")}`,
    );
    const raw = (status: number, body: string) =>
      (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await importFileDestination(form(), raw(500, "<html>error</html>"))).toBe(
      "/dashboard/import?error=import_failed",
    );
    // A 413 from in front of the route (not its JSON) is still too large.
    expect(await importFileDestination(form(), raw(413, "<html>Payload Too Large</html>"))).toBe(
      "/dashboard/import?error=file_too_large",
    );
  });

  test("a signed-out session goes to login; a network failure is read_failed", async () => {
    expect(await importFileDestination(form(), stub(401, { error: "unauthenticated" }).fetchImpl)).toBe(
      "/login?next=/dashboard/import",
    );
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await importFileDestination(form(), down)).toBe("/dashboard/import?error=read_failed");
  });
});
