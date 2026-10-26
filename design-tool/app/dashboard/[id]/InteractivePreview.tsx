"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { K12_MACROS, type BundleAsset, type ItemResponse } from "@secure-test/schema";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  buildPreviewBundle,
  createPreviewSealer,
  previewAssetIds,
  type PreviewSealer,
  type PreviewSkip,
} from "@/lib/preview/interactive/bundle";
import {
  acceptReady,
  loadMessage,
  parseFrameMessage,
  scrollToMessage,
  speechMessage,
  type PreviewPayload,
  type TtsRequest,
} from "@/lib/preview/interactive/protocol";
import { scorePreview, type PreviewScore } from "@/lib/preview/interactive/score";
import { PREVIEW_SPEECH_RATE, utteranceFor, wordAt } from "@/lib/preview/interactive/speech";
import type { AssessmentView, ItemSetView, ItemView } from "./editorModel";

/** How long the editor waits after the last edit before refreshing the preview. */
const REFRESH_MS = 600;
/** A frame that has not rendered by then is reported as failed. */
const START_TIMEOUT_MS = 20_000;
/** How long Follow my place stays quiet after a click in the preview scrolls
 * the editor (longer than a smooth scroll plus the 150 ms follow delay). */
const JUMP_QUIET_MS = 1500;

interface FrameSlot {
  key: number;
  payload: PreviewPayload;
  skipped: PreviewSkip[];
}

const OUTCOME_LABEL: Record<PreviewScore["rows"][number]["outcome"], string> = {
  correct: "Correct",
  partly: "Partly correct",
  wrong: "Incorrect",
  unanswered: "Not answered",
  by_hand: "Scored by hand after the test",
  no_key: "No answer key yet",
};

/**
 * Editor redesign Phase 5 slice B (D-2, R-3, R-11), behind the R-12 flag:
 * the student's own renderer, answerable, beside the editor. ADR 0019
 * (Proposed) is the posture: the frame is `/preview/shell` in an iframe with
 * `sandbox="allow-scripts"` only (opaque origin) and `allow=""`; content goes
 * in over the MessageChannel the frame offers in its `ready`, as a bundle
 * built by the student's delivery projection and parsed by
 * DeliveryBundleSchema (lib/preview/interactive/bundle.ts); answers come
 * back through the stub bridge and stay in this component's memory; "Finish
 * and hand in" is scored HERE against the editor's key
 * (lib/preview/interactive/score.ts), and the result is shown below the
 * frame, never in it.
 *
 * Live refresh: each edit (debounced) builds a fresh frame document; the new
 * frame loads hidden behind the current one and replaces it once it has
 * rendered, so the preview never blanks while typing. Answers given so far
 * ride the next frame as `saved_responses`, so they survive the refresh.
 */
export function InteractivePreview({
  assessment,
  items,
  itemSets,
  onShowItem,
  frameClassName,
}: {
  assessment: AssessmentView;
  items: ItemView[];
  itemSets: ItemSetView[];
  /** Show this question in the editor. `frame`: a click on its text in the
   * preview (scroll only — the teacher is still in the preview); `score`: a
   * "Question N" link under the result (an explicit move to the editor). */
  onShowItem: (itemId: string, from: "frame" | "score") => void;
  frameClassName?: string;
}) {
  const [tts, setTts] = useState(false);
  const [paged, setPaged] = useState(assessment.student_layout === "paged");
  const [linkScroll, setLinkScroll] = useState(true);
  const [assets, setAssets] = useState<Record<string, BundleAsset>>({});
  const [frames, setFrames] = useState<{ shown: FrameSlot | null; next: FrameSlot | null }>({
    shown: null,
    next: null,
  });
  const [linked, setLinked] = useState(false);
  /** The key of the last frame that reported `rendered`. */
  const [renderedKey, setRenderedKey] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [score, setScore] = useState<PreviewScore | null>(null);
  const [answered, setAnswered] = useState(0);
  const [resetCount, setResetCount] = useState(0);
  const [speechNote, setSpeechNote] = useState<string | null>(null);

  const sealerRef = useRef<PreviewSealer | null>(null);
  sealerRef.current ??= createPreviewSealer();
  const answersRef = useRef<Record<string, ItemResponse>>({});
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const renderedRef = useRef(renderedKey);
  renderedRef.current = renderedKey;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onShowRef = useRef(onShowItem);
  onShowRef.current = onShowItem;
  const linkRef = useRef(linkScroll);
  linkRef.current = linkScroll;
  const iframes = useRef(new Map<number, HTMLIFrameElement>());
  const ports = useRef(new Map<number, MessagePort>());
  const loads = useRef(new Map<number, number>());
  const keyRef = useRef(0);
  const lastPayload = useRef("");
  const anchorRef = useRef<string | null>(null);
  /** Until this time (ms), Follow my place sends nothing: the editor is
   * scrolling because of a click in the preview, and following it back would
   * move the page the teacher just clicked in. */
  const quietUntil = useRef(0);
  const fetching = useRef(new Set<string>());

  // Pictures go in as the bundle's base64 `assets` (the frame has no network).
  const wantedAssets = previewAssetIds(items, itemSets).join(",");
  useEffect(() => {
    for (const id of wantedAssets ? wantedAssets.split(",") : []) {
      if (fetching.current.has(id)) continue;
      fetching.current.add(id);
      void (async () => {
        try {
          const res = await fetch(
            `/api/assessments/${encodeURIComponent(assessment.id)}/assets/${encodeURIComponent(id)}`,
          );
          if (!res.ok) return;
          const blob = await res.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          if (!base64) return;
          setAssets((a) => ({ ...a, [id]: { content_type: blob.type || "application/octet-stream", base64 } }));
        } catch {
          // A picture that cannot be fetched shows the renderer's own
          // "image not found" — the same as a student's missing asset.
        }
      })();
    }
  }, [wantedAssets, assessment.id]);

  // Live refresh (debounced): a new frame document per change.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        const { bundle, skipped } = buildPreviewBundle({
          assessment,
          items,
          sets: itemSets,
          layout: paged ? "paged" : "scroll",
          tts,
          assets,
          saved: answersRef.current,
          sealer: sealerRef.current!,
        });
        const payload: PreviewPayload = {
          bundle,
          offline: true,
          tts_scope: { items: tts, stimuli: tts, responses: tts },
          stt_state: "off",
          katex_macros: { ...K12_MACROS },
        };
        const text = JSON.stringify(payload);
        if (text === lastPayload.current) return;
        lastPayload.current = text;
        keyRef.current += 1;
        const slot = { key: keyRef.current, payload, skipped };
        setFrames((f) => (f.shown ? { shown: f.shown, next: slot } : { shown: slot, next: null }));
      },
      lastPayload.current ? REFRESH_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [assessment, items, itemSets, paged, tts, assets, resetCount]);

  // Ports of frames that are gone are closed; a frame that never renders is
  // reported.
  const pendingKey = frames.next?.key ?? (frames.shown && frames.shown.key !== renderedKey ? frames.shown.key : null);
  useEffect(() => {
    const live = new Set([frames.shown?.key, frames.next?.key].filter((k): k is number => k != null));
    for (const [key, port] of ports.current) {
      if (!live.has(key)) {
        port.close();
        ports.current.delete(key);
      }
    }
  }, [frames]);
  useEffect(() => {
    if (pendingKey === null) return;
    const timer = setTimeout(() => {
      if (renderedRef.current !== pendingKey) setFailed(true);
    }, START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingKey]);

  useEffect(() => {
    function post(key: number, message: unknown) {
      try {
        ports.current.get(key)?.postMessage(message);
      } catch {
        // A closed port: the frame is being replaced.
      }
    }

    function promote(key: number, isLinked: boolean) {
      const f = framesRef.current;
      if (f.next?.key === key) {
        setFrames({ shown: f.next, next: null });
      } else if (f.shown?.key !== key) {
        return;
      }
      setLinked(isLinked);
      setRenderedKey(key);
      setFailed(false);
      if (linkRef.current && anchorRef.current) post(key, scrollToMessage(anchorRef.current, false));
    }

    function speak(key: number, request: TtsRequest) {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
      if (!synth) {
        setSpeechNote("This browser can't read aloud.");
        return;
      }
      if (request.action === "stop") {
        synth.cancel();
        return;
      }
      if (request.action === "pause" || request.action === "resume") {
        if (request.action === "pause") synth.pause();
        else synth.resume();
        return;
      }
      synth.cancel();
      // On-device voices only: some browsers' default voices send the text
      // to a cloud service.
      const voice = synth.getVoices().find((v) => v.localService && v.lang.toLowerCase().startsWith("en"));
      if (!voice) {
        setSpeechNote("Read-aloud needs an English voice installed on this computer.");
        post(key, speechMessage("cancelled", request.id));
        return;
      }
      setSpeechNote(null);
      const utterance = utteranceFor(request.segments);
      const u = new SpeechSynthesisUtterance(utterance.text);
      u.voice = voice;
      u.rate = PREVIEW_SPEECH_RATE[request.rate];
      u.onstart = () => post(key, speechMessage("started", request.id));
      u.onpause = () => post(key, speechMessage("paused", request.id));
      u.onresume = () => post(key, speechMessage("resumed", request.id));
      u.onboundary = (event) => {
        if (event.name !== "word") return;
        const word = wordAt(utterance, event.charIndex, event.charLength);
        if (word) post(key, speechMessage("word", request.id, word));
      };
      u.onend = () => post(key, speechMessage("finished", request.id));
      u.onerror = () => post(key, speechMessage("cancelled", request.id));
      synth.speak(u);
    }

    function onPortMessage(key: number, data: unknown) {
      const message = parseFrameMessage(data);
      if (!message) return;
      const f = framesRef.current;
      const shown = f.shown?.key === key;
      if (!shown && f.next?.key !== key) return;
      if (message.kind === "rendered") {
        promote(key, message.linked);
        return;
      }
      if (message.kind === "error") {
        console.warn("preview frame error", message.message);
        return;
      }
      // Everything else is the student's side of the page: the visible frame only.
      if (!shown) return;
      const bundleItem = f.shown!.payload.bundle.items.find(
        (i) => "item_id" in message && i.id === message.item_id,
      );
      switch (message.kind) {
        case "jump":
          if (!bundleItem) return;
          quietUntil.current = Date.now() + JUMP_QUIET_MS;
          anchorRef.current = message.item_id;
          onShowRef.current(message.item_id, "frame");
          return;
        case "response":
          if (!bundleItem || bundleItem.type !== message.response.type) return;
          answersRef.current = { ...answersRef.current, [message.item_id]: message.response };
          setAnswered(Object.keys(answersRef.current).length);
          setScore(null);
          return;
        case "withdraw": {
          if (!bundleItem) return;
          const { [message.item_id]: _gone, ...rest } = answersRef.current;
          answersRef.current = rest;
          setAnswered(Object.keys(rest).length);
          setScore(null);
          return;
        }
        case "submit":
          setScore(scorePreview(itemsRef.current, answersRef.current, sealerRef.current!));
          return;
        case "tts":
          speak(key, message.request);
          return;
        case "ignored":
          return;
      }
    }

    function onWindowMessage(event: MessageEvent) {
      for (const [key, frame] of iframes.current) {
        const port = acceptReady(event, frame.contentWindow);
        if (!port) continue;
        const slot = framesRef.current.shown?.key === key ? framesRef.current.shown : framesRef.current.next;
        if (!slot || slot.key !== key || ports.current.has(key)) return;
        ports.current.set(key, port);
        port.onmessage = (e) => onPortMessage(key, e.data);
        post(key, loadMessage(slot.payload));
        return;
      }
    }

    window.addEventListener("message", onWindowMessage);
    const portMap = ports.current;
    return () => {
      window.removeEventListener("message", onWindowMessage);
      for (const port of portMap.values()) port.close();
      portMap.clear();
      window.speechSynthesis?.cancel();
    };
  }, []);

  // Scroll linking (R-11): by anchored question, editor → preview. The
  // anchor is the first question card in the top half of the window.
  const itemKey = items.map((i) => i.id).join("|");
  useEffect(() => {
    if (!linkScroll || typeof IntersectionObserver !== "function") return;
    const visible = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id.slice("question-".length);
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const anchor = itemsRef.current.find((i) => visible.has(i.id))?.id;
        if (!anchor || anchor === anchorRef.current) return;
        anchorRef.current = anchor;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const shown = framesRef.current.shown;
          if (!shown || Date.now() < quietUntil.current) return;
          try {
            ports.current.get(shown.key)?.postMessage(scrollToMessage(anchor, true));
          } catch {
            // Replaced meanwhile.
          }
        }, 150);
      },
      { rootMargin: "0px 0px -50% 0px" },
    );
    for (const id of itemKey ? itemKey.split("|") : []) {
      const el = document.getElementById(`question-${id}`);
      if (el) observer.observe(el);
    }
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [linkScroll, itemKey]);

  function resetAnswers() {
    answersRef.current = {};
    setAnswered(0);
    setScore(null);
    lastPayload.current = "";
    setResetCount((n) => n + 1);
  }

  const skipped = frames.shown?.skipped ?? [];
  const numberOf = (id: string) => items.findIndex((i) => i.id === id) + 1;
  const slots = [frames.shown, frames.next].filter((s): s is FrameSlot => s !== null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={tts} onChange={(e) => setTts(e.target.checked)} />
          Read aloud
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={paged} onChange={(e) => setPaged(e.target.checked)} />
          One question per page
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={linkScroll} onChange={(e) => setLinkScroll(e.target.checked)} />
          Follow my place
        </label>
        <Button type="button" variant="outline" size="sm" onClick={resetAnswers} disabled={answered === 0 && !score}>
          <RotateCcw className="size-4" aria-hidden />
          Clear my answers
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This is the student&apos;s page, live. Answer questions and press Finish and hand in to see how they would be
        scored. Nothing is saved, and these views don&apos;t change the test&apos;s settings.
        {linkScroll && !linked && frames.shown ? " Following your place isn't available for this view." : ""}
      </p>
      {speechNote ? <p className="text-xs text-warning-foreground">{speechNote}</p> : null}
      {failed ? (
        <Alert variant="destructive">
          <AlertTitle>The student preview didn&apos;t start. Reload the page to try again.</AlertTitle>
        </Alert>
      ) : null}
      <div className={`relative overflow-hidden rounded-md border bg-white ${frameClassName ?? "h-[70vh]"}`}>
        {renderedKey === null && !failed ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            Loading the student view…
          </div>
        ) : null}
        {slots.map((slot) => (
          <iframe
            key={slot.key}
            ref={(el) => {
              if (el) iframes.current.set(slot.key, el);
              else iframes.current.delete(slot.key);
            }}
            src="/preview/shell"
            // ADR 0019 §1: scripts only — no allow-same-origin, so the
            // document's origin is opaque (no cookies, storage or API).
            sandbox="allow-scripts"
            allow=""
            referrerPolicy="no-referrer"
            title={slot.key === frames.shown?.key ? "Student preview" : "Student preview (updating)"}
            aria-hidden={slot.key === frames.shown?.key ? undefined : true}
            tabIndex={slot.key === frames.shown?.key ? undefined : -1}
            onLoad={() => {
              // A frame document loads once. A second load means the frame
              // navigated itself (ADR 0019 risk 2): its port is dropped and
              // a fresh frame is built.
              const n = (loads.current.get(slot.key) ?? 0) + 1;
              loads.current.set(slot.key, n);
              if (n > 1) {
                ports.current.get(slot.key)?.close();
                ports.current.delete(slot.key);
                lastPayload.current = "";
                setResetCount((c) => c + 1);
              }
            }}
            className={`absolute inset-0 h-full w-full ${
              slot.key === frames.shown?.key ? "" : "invisible"
            }`}
          />
        ))}
      </div>
      {skipped.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {skipped.map((s) => (
            <li key={`${s.what}-${s.itemId}`}>
              {s.what === "question"
                ? `Question ${numberOf(s.itemId)} isn't shown yet — finish its answer options first.`
                : `The passage with question ${numberOf(s.itemId)} isn't shown yet — check its source labels.`}
            </li>
          ))}
        </ul>
      ) : null}
      {score ? (
        <div role="status" className="space-y-2 rounded-md border bg-card p-3 text-sm">
          <p className="font-medium">
            {score.max > 0
              ? `${score.points} of ${score.max} points on the machine-scored questions`
              : "No machine-scored questions with an answer key yet"}
          </p>
          <ul className="space-y-0.5">
            {score.rows.map((row) => (
              <li key={row.itemId}>
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => onShowItem(row.itemId, "score")}>
                  Question {row.number}
                </button>
                {": "}
                {OUTCOME_LABEL[row.outcome]}
                {row.max !== null && row.outcome !== "unanswered" ? ` (${row.points} / ${row.max})` : ""}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Scored here with your answer key, the way a student&apos;s hand-in is scored. Nothing was saved.
          </p>
        </div>
      ) : null}
    </div>
  );
}
