// Help-page capture (docs/help-capture.md): drive fictional demo students
// through the student API against LOCAL dev, the same calls the macOS client
// makes — redeem → start attempt → delivery → events → responses → submit —
// so the Monitor, scoring queue and results have something to show.
//
//   cd design-tool
//   bun --env-file=.env.local scripts/help-capture/sim-students.ts <CODE> probe
//   bun --env-file=.env.local scripts/help-capture/sim-students.ts <CODE> scripts/help-capture/content/monitor-plan.json
//
// Answers are written for the "Cell Structure Check-in" content
// (content/cell-structure-items.csv plus the matching and ordering questions
// in docs/help-capture.md). Refuses anything but a localhost server.
import { mintSessionJWT } from "../../lib/auth/session";

const BASE = process.env.HELP_CAPTURE_BASE ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("sim-students only talks to a local dev server");
  process.exit(2);
}
const [code, mode] = process.argv.slice(2);
if (!code || !mode) {
  console.error("usage: sim-students.ts <SESSION_CODE> <probe | plan.json>");
  process.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(email: string) {
  return mintSessionJWT({ sub: `dev-mint-${email.split("@")[0]}`, role: "student", email, hd: "edtools.psd401.net" });
}
async function call(t: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 200)}`);
  return json;
}

async function join(email: string) {
  const t = await token(email);
  const r = await call(t, "POST", "/api/test-sessions/redeem", { code });
  const a = await call(t, "POST", "/api/attempts", { test_session_id: r.test_session_id });
  const bundle = await call(t, "GET", `/api/assessments/${r.assessment_id}/delivery`);
  return { t, attemptId: a.attempt.id as string, bundle };
}

function answerFor(item: any, quality: "good" | "mixed"): any {
  const good = quality === "good";
  switch (item.type) {
    case "multiple_choice_single":
      return { type: item.type, choice_id: item.choices[good ? 1 : 0].id };
    case "multiple_choice_multi":
      return { type: item.type, choice_ids: item.choices.slice(0, good ? 2 : 1).map((c: any) => c.id) };
    case "short_text":
      return { type: item.type, text: good ? "osmosis" : "diffusion" };
    case "essay":
      return {
        type: item.type,
        text: good
          ? "The membrane is a phospholipid bilayer. The fatty tails in the middle keep out charged particles, so only small nonpolar molecules slip through on their own. Channel and carrier proteins in the bilayer let specific ions and sugars cross, and pumps use energy to move some substances against their gradient. Together these features make the membrane selectively permeable."
          : "The membrane is like a wall around the cell. It has holes that let good things in and keeps bad things out.",
      };
    case "match": {
      // Match and order ids are sealed per attempt, so answer by text.
      const want: Record<string, string> = { Nucleus: "Stores the cell's DNA", Ribosome: "Builds proteins", Mitochondrion: "Releases energy from food" };
      const rightId = (text: string) => item.rights.find((r: any) => r.text === text)?.id;
      const lefts = item.lefts as any[];
      const matches: Record<string, string> = {};
      lefts.forEach((l, i) => {
        matches[l.id] = rightId(good ? want[l.text]! : want[lefts[(i + 1) % lefts.length].text]!);
      });
      return { type: item.type, matches };
    }
    case "order": {
      const rank = ["DNA is transcribed", "mRNA leaves", "A ribosome reads", "The protein is packaged"];
      const pos = (e: any) => rank.findIndex((r) => e.label.startsWith(r));
      const sorted = [...item.entries].sort((a: any, b: any) => pos(a) - pos(b));
      if (!good) [sorted[1], sorted[2]] = [sorted[2], sorted[1]];
      return { type: item.type, ordered_ids: sorted.map((e: any) => e.id) };
    }
    default:
      return null;
  }
}

if (mode === "probe") {
  const s = await join("avery.brooks@edtools.psd401.net");
  console.log(JSON.stringify(s.bundle.items.map((i: any) => ({ type: i.type, keys: Object.keys(i) })), null, 1));
  process.exit(0);
}

type Step = { email: string; at: number; quality: "good" | "mixed"; answer: number; submit?: boolean; focusLoss?: boolean };
const plan: Step[] = JSON.parse(await Bun.file(mode).text());
const t0 = Date.now();
await Promise.all(
  plan.map(async (s) => {
    await sleep(s.at * 1000);
    const { t, attemptId, bundle } = await join(s.email);
    await call(t, "POST", `/api/attempts/${attemptId}/events`, { kind: "lockdown_begin" });
    for (const item of bundle.items.slice(0, s.answer)) {
      await sleep(2500);
      const response = answerFor(item, s.quality);
      if (response) await call(t, "PUT", `/api/attempts/${attemptId}/responses/${item.id}`, { response });
    }
    if (s.focusLoss) await call(t, "POST", `/api/attempts/${attemptId}/events`, { kind: "focus_loss" });
    if (s.submit) {
      await sleep(1500);
      await call(t, "POST", `/api/attempts/${attemptId}/submit`, {});
      await call(t, "POST", `/api/attempts/${attemptId}/events`, { kind: "lockdown_end" }).catch(() => {});
    }
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s.email.split("@")[0]} done`);
  }),
);
