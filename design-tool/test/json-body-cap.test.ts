// JSON body ceilings (2026-10-25, the stopgap for zod advisory
// GHSA-mrhx-c7xc-m3w5): the helper's refusals, the rule that no API route
// reads `req.json()` directly, and each route's tier pinned so a change to
// one is a deliberate diff here too.
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { JSON_BODY_LIMITS, readJsonBody } from "../lib/api/jsonBody";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    // @ts-expect-error -- `duplex` is required for a stream body; not in lib.dom yet.
    duplex: "half",
  });

describe("readJsonBody", () => {
  test("a body within the limit parses, multi-byte text intact", async () => {
    const read = await readJsonBody(post(JSON.stringify({ a: [1, 2], t: "é中" })), 1024);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.parse()).toEqual({ a: [1, 2], t: "é中" });
  });

  test("exactly at the limit parses; one byte over is 413", async () => {
    const at = JSON.stringify({ p: "x".repeat(100) });
    const atRead = await readJsonBody(post(at), at.length);
    expect(atRead.ok).toBe(true);
    const over = await readJsonBody(post(at), at.length - 1);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.response.status).toBe(413);
      expect(await over.response.json()).toEqual({ ok: false, error: "body_too_large", limit: at.length - 1 });
    }
  });

  test("a declared Content-Length over the limit is refused without reading the body", async () => {
    const req = post("{}", { "content-length": String(10 * 1024 * 1024) });
    expect(req.headers.get("content-length")).toBe(String(10 * 1024 * 1024));
    const read = await readJsonBody(req, 1024);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.response.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });

  test("a body with no length stops being read at the limit", async () => {
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 100) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const req = post(body);
    expect(req.headers.get("content-length")).toBeNull();
    const read = await readJsonBody(req, JSON_BODY_LIMITS.default);
    expect(read.ok).toBe(false);
    // 256 KiB is 4 chunks of 64 KiB; the 5th passes it. Not all 100.
    expect(sent).toBeLessThan(10);
  });

  test("malformed or empty JSON throws from parse(), as req.json() did, so each route keeps its own 400", async () => {
    for (const text of ["{not json", ""]) {
      const read = await readJsonBody(post(text), 1024);
      expect(read.ok).toBe(true);
      if (read.ok) expect(() => read.parse()).toThrow();
    }
  });
});

const API = path.join(import.meta.dir, "..", "app", "api");

async function routeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await routeFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("every API route reads JSON through readJsonBody", () => {
  test("no direct req.json() / request.json() under app/api", async () => {
    const offenders: string[] = [];
    for (const f of await routeFiles(API)) {
      const src = await Bun.file(f).text();
      if (/\b(req|request)\.json\(\)/.test(src)) offenders.push(path.relative(API, f));
    }
    expect(offenders).toEqual([]);
  });

  // The tiers that are not the default, by route. A route added to a tier, or
  // moved out of one, changes this table on purpose.
  const NON_DEFAULT: Record<string, keyof typeof JSON_BODY_LIMITS> = {
    "attempts/[attemptId]/events/route.ts": "small",
    "feedback/route.ts": "small",
    "me/preferences/route.ts": "small",
    "auth/exchange/route.ts": "small",
    "attempts/[attemptId]/responses/[itemId]/route.ts": "longText",
    "client-errors/route.ts": "longText",
    "assessments/[id]/item-sets/route.ts": "longText",
    "assessments/[id]/item-sets/[setId]/route.ts": "longText",
    "assessments/[id]/rubrics/extract/route.ts": "longText",
    "ai/generate-items/route.ts": "longText",
    "attempts/[attemptId]/peek/upload/route.ts": "peekImage",
    "assessments/[id]/items/import/route.ts": "csvImport",
  };

  test("each route reads with its tier's named limit, never a bare number", async () => {
    const seen: Record<string, string> = {};
    for (const f of await routeFiles(API)) {
      const src = await Bun.file(f).text();
      const calls = [...src.matchAll(/readJsonBody\(req,\s*([^)]+)\)/g)].map((m) => m[1]!.trim());
      if (calls.length === 0) continue;
      const rel = path.relative(API, f);
      expect(calls.length).toBe(1);
      const tier = /^JSON_BODY_LIMITS\.(\w+)$/.exec(calls[0]!)?.[1];
      expect(tier, `${rel} reads with ${calls[0]}`).toBeDefined();
      seen[rel] = tier!;
    }
    expect(Object.keys(seen).length).toBe(47);
    for (const [rel, tier] of Object.entries(seen)) {
      expect(`${rel}: ${tier}`).toBe(`${rel}: ${NON_DEFAULT[rel] ?? "default"}`);
    }
  });
});
