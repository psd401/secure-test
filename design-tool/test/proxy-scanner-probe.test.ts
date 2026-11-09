import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { isScannerProbe, proxy } from "../proxy";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";

const ORIGIN = "http://localhost:3000";

// The paths a scanner actually sent to production, so the block is pinned to
// real traffic rather than to a guess at what scanners look like.
const PROBES = [
  "/wp-admin/admin-ajax.php",
  "/wp-content/plugins/wp-file-manager/lib/php/connector.minimal.php",
  "/wp-content/plugins/contact-form-7-db/img/upload.php",
  "/wp-content/plugins/backup-backup/includes/backup-heart.php",
  "/wp-content/plugins/blueimp-jquery-file-upload/server/php/index.php",
  "/wp-content/plugins/formcraft/file-upload/server/content/upload.php",
  "/wp-json/bricks/v1/render_element",
];

describe("isScannerProbe", () => {
  test.each(PROBES)("matches %s", (path) => {
    expect(isScannerProbe(path)).toBe(true);
  });

  test.each(["/wp-admin", "/WP-ADMIN/x", "/xmlrpc.php", "/blog/wp-login.PHP"])(
    "matches %s",
    (path) => {
      expect(isScannerProbe(path)).toBe(true);
    },
  );

  test.each([
    "/",
    "/login",
    "/dashboard",
    "/admin",
    "/api/attempts",
    "/help.html",
    "/wp-foo",
    "/wp-administrator",
    "/dashboard/wp-admin",
    "/notes.php/more",
  ])("leaves %s alone", (path) => {
    expect(isScannerProbe(path)).toBe(false);
  });
});

describe("proxy", () => {
  test("answers a probe POST with an empty 404 and a request id", async () => {
    const res = await proxy(
      new NextRequest(`${ORIGIN}/wp-admin/admin-ajax.php`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "garbage",
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  test("still sends a signed-out dashboard visit to login", async () => {
    const res = await proxy(new NextRequest(`${ORIGIN}/dashboard`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("still passes an ordinary path through", async () => {
    const res = await proxy(new NextRequest(`${ORIGIN}/login`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});
