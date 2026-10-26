// Read-aloud in the interactive preview (editor redesign Phase 5 slice B,
// R-11; ADR 0019 §5 as amended for `tts`). The renderer's Speak control posts
// `{action: "speak", id, rate, segments}` on the `tts` channel, as it does to
// the macOS host; the editor page speaks it with the browser's own speech
// synthesis and reports each word back, so the frame highlights it the way
// the student's page does.
//
// Pure: how segments become one utterance and how a word boundary maps back
// to (segment, offset, length). A formula is spoken from a plain reading of
// its TeX (`latexToText`) — an approximation of the client's MathSpeech
// (Swift), which does not run in a browser.
import { latexToText } from "@secure-test/graphing/server";
import type { TtsSegment } from "./protocol";

export interface SpokenSpan {
  segment: number;
  kind: "text" | "math";
  start: number;
  end: number;
}

export interface Utterance {
  text: string;
  spans: SpokenSpan[];
}

/** Speech-synthesis rates for the page's three steps (1 = the voice's default). */
export const PREVIEW_SPEECH_RATE = { slow: 0.8, normal: 1, fast: 1.2 } as const;

/** `\$` is spoken as `$` (the renderer maps offsets back the same way). */
function spokenTextSegment(text: string): string {
  return text.replace(/\\\$/g, "$");
}

export function utteranceFor(segments: readonly TtsSegment[]): Utterance {
  let text = "";
  const spans: SpokenSpan[] = [];
  segments.forEach((seg, segment) => {
    const spoken = seg.kind === "math" ? latexToText(seg.tex) : spokenTextSegment(seg.text);
    if (spoken.length === 0) return;
    if (text.length > 0) text += " ";
    spans.push({ segment, kind: seg.kind, start: text.length, end: text.length + spoken.length });
    text += spoken;
  });
  return { text, spans };
}

/**
 * The word a `boundary` event names, as the renderer's
 * `__secureTestSpeech.word(id, segment, offset, length)` takes it — offsets
 * into the segment's own spoken text; a formula is marked whole (0, 0).
 * `charLength` is missing in some browsers: then the word runs to the next
 * space.
 */
export function wordAt(
  utterance: Utterance,
  charIndex: number,
  charLength?: number,
): { segment: number; offset: number; length: number } | null {
  const span = utterance.spans.find((s) => charIndex >= s.start && charIndex < s.end);
  if (!span) return null;
  if (span.kind === "math") return { segment: span.segment, offset: 0, length: 0 };
  let length = charLength && charLength > 0 ? charLength : 0;
  if (length === 0) {
    const rest = utterance.text.slice(charIndex, span.end);
    const m = /^\S+/.exec(rest);
    length = m ? m[0].length : 0;
  }
  length = Math.min(length, span.end - charIndex);
  return { segment: span.segment, offset: charIndex - span.start, length };
}
