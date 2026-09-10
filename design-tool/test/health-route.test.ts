import { describe, expect, it } from "bun:test";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns 200 {ok:true, commit:null} with no auth, no DB and no build stamp", async () => {
    const prev = process.env.APP_COMMIT;
    delete process.env.APP_COMMIT;
    try {
      const res = GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, commit: null });
    } finally {
      if (prev !== undefined) process.env.APP_COMMIT = prev;
    }
  });

  it("surfaces APP_COMMIT as the build stamp", async () => {
    const prev = process.env.APP_COMMIT;
    process.env.APP_COMMIT = "abc1234";
    try {
      expect(await GET().json()).toEqual({ ok: true, commit: "abc1234" });
    } finally {
      if (prev === undefined) delete process.env.APP_COMMIT;
      else process.env.APP_COMMIT = prev;
    }
  });
});
