// Dev-only: mint a design-tool session JWT for a student, for launching the
// macOS client without Google (SECURE_TEST_TOKEN). Established 2026-08-31
// when Google sign-in stickiness (ux-pass-2 follow-up, slice 9) blocked
// switching demo accounts mid-session.
//
//   bun --env-file=.env.local scripts/mint-student.ts <demo-student-B>@edtools.psd401.net
//
// Needs DESIGN_TOOL_SESSION_SECRET (from .env.local). Role/email drive the
// roster join; sub is a stable dev marker.
import { mintSessionJWT } from "../lib/auth/session";

const email = process.argv[2];
if (!email) {
  console.error("usage: bun --env-file=.env.local scripts/mint-student.ts <student-email>");
  process.exit(2);
}
const token = await mintSessionJWT({
  sub: `dev-mint-${email.split("@")[0]}`,
  role: "student",
  email,
  hd: email.split("@")[1],
});
console.log(token);
