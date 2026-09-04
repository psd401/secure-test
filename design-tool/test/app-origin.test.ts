import { afterEach, describe, expect, it } from "bun:test";
import { appOrigin } from "@/lib/auth/appOrigin";

const saved = process.env.OIDC_REDIRECT_URI;
afterEach(() => {
  if (saved === undefined) delete process.env.OIDC_REDIRECT_URI;
  else process.env.OIDC_REDIRECT_URI = saved;
});

describe("appOrigin", () => {
  it("uses OIDC_REDIRECT_URI's origin, not the request's (the ALB case)", () => {
    process.env.OIDC_REDIRECT_URI =
      "https://app.example.test/api/auth/callback";
    const req = new Request(
      "http://ip-10-0-1-201.us-west-2.compute.internal:3000/api/auth/callback?code=x",
    );
    expect(appOrigin(req)).toBe("https://app.example.test");
  });

  it("falls back to the request origin when the env is unset", () => {
    delete process.env.OIDC_REDIRECT_URI;
    const req = new Request("http://localhost:3000/api/auth/logout");
    expect(appOrigin(req)).toBe("http://localhost:3000");
  });
});
