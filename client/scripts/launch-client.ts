// Dev-only: launch the built SecureTest client against the local dev server, signed in via Google.
// Run: bun --env-file=/Users/cantonwinej/code/secure-test/design-tool/.env.local launch-client.ts <path-to-SecureTest.app>
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
const app = process.argv[2];
if (!app) { console.error("usage: launch-client.ts <SecureTest.app>"); process.exit(2); }
const aud = (process.env.OIDC_AUDIENCE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const web = process.env.OIDC_CLIENT_ID ?? "";
const native = aud.find((id) => id !== web);
if (!native) { console.error("no native client id in OIDC_AUDIENCE (entries:", aud.length, ")"); process.exit(2); }
const log = `${process.env.HOME}/securetest-student.log`;
const err = openSync(log, "a");
const child = spawn(`${app}/Contents/MacOS/SecureTest`, [], {
  env: {
    HOME: process.env.HOME!, PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp",
    SECURE_TEST_SERVER: process.env.SECURE_TEST_SERVER ?? "http://localhost:3000",
    SECURE_TEST_GOOGLE_CLIENT_ID: native,
    ...(process.env.SECURE_TEST_SIMULATE_LOCKDOWN ? { SECURE_TEST_SIMULATE_LOCKDOWN: process.env.SECURE_TEST_SIMULATE_LOCKDOWN } : {}),
    ...(process.env.SECURE_TEST_TOKEN ? { SECURE_TEST_TOKEN: process.env.SECURE_TEST_TOKEN } : {}),
    // Observability slice 4 hand-run: the debug crash menu item (Session menu).
    ...(process.env.SECURE_TEST_DEBUG_CRASH ? { SECURE_TEST_DEBUG_CRASH: process.env.SECURE_TEST_DEBUG_CRASH } : {}),
    // C-7 / D-9 (docs/multi-source-stimulus-design.md): dev-only pass-through; fullscreen stays the app default.
    ...(process.env.SECURE_TEST_NO_FULLSCREEN ? { SECURE_TEST_NO_FULLSCREEN: process.env.SECURE_TEST_NO_FULLSCREEN } : {}),
  },
  detached: true, stdio: ["ignore", "ignore", err],
});
child.unref();
console.log(`launched pid ${child.pid}; client id …${native.slice(-12)}; stderr → ${log}`);
