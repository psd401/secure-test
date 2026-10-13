// The `requires` vocabulary (docs/server-delivered-renderer-design.md D-4 /
// D-5): what a served renderer may ask of the shell. The shell refuses,
// before `begin()`, a renderer whose manifest names something it lacks.
//
// - The eight bridge handlers the page posts to.
// - Host features that are not a handler of their own: `tts.word_ranges`
//   (word-highlight callbacks from read-aloud) and `response.generic` (the
//   generic `{item_id, type, value}` answer channel, D-5).
//
// Adding a term is a shell change: a renderer may only name what a shell on
// the fleet can answer for.

export const REQUIREMENTS = [
  "response",
  "withdraw",
  "upload",
  "submit",
  "timer",
  "home",
  "tts",
  "stt",
  "tts.word_ranges",
  "response.generic",
] as const;

export type Requirement = (typeof REQUIREMENTS)[number];

export function isRequirement(value: unknown): value is Requirement {
  return (
    typeof value === "string" &&
    (REQUIREMENTS as readonly string[]).includes(value)
  );
}

// What the bridge-mode renderer (D-9 — the page code extracted from the
// client's `AssessmentPage.rendererScript`) uses: each
// `window.webkit.messageHandlers.<name>.postMessage` in the page (response,
// withdraw, upload, submit, timer, home, tts, stt) plus `tts.word_ranges`
// (the page defines `window.__secureTestSpeech.word`, which the host calls
// with each spoken word's range). Not `response.generic`: the page still
// posts the typed `response` shapes; the generic channel arrives with D-5.
// test/extract.test.ts re-derives the handler list from the extracted page
// and fails when the two drift.
export const BRIDGE_REQUIRES: readonly Requirement[] = [
  "home",
  "response",
  "stt",
  "submit",
  "timer",
  "tts",
  "tts.word_ranges",
  "upload",
  "withdraw",
];
