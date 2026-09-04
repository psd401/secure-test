import { describe, expect, it } from "bun:test";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns 200 {ok:true} with no auth and no DB", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
