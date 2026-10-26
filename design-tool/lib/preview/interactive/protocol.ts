// The editor page's side of the preview frame's protocol (editor redesign
// Phase 5 slice B, ADR 0019 §4–§5). Pure and browser-safe: every check the
// page makes on what the frame sends lives here, so it is tested headlessly.
//
// Everything from the frame is untrusted input (ADR 0019 §5): it is
// validated against its shape, unknown kinds and handlers are dropped, and
// nothing from it is ever rendered as HTML by the page.
//
//   frame → window   { type: PREVIEW_PROTOCOL, kind: "ready", version } + 1 port
//                    accepted only when event.source is OUR iframe's window
//                    (every opaque-origin frame reports origin "null", so the
//                    origin says nothing)
//   page  → port     load {payload} · scroll_to {item_id, smooth} · speech {…}
//   frame → port     bridge {handler, body} · rendered {linked, items}
//                    · jump {item_id} · error {message}
import { z } from "zod";
import { ItemResponseSchema, type DeliveryBundle, type ItemResponse } from "@secure-test/schema";
import { PREVIEW_PROTOCOL, PREVIEW_PROTOCOL_VERSION } from "./bootstrap";

export { PREVIEW_PROTOCOL, PREVIEW_PROTOCOL_VERSION };

/** The shape of a window `message` event the page needs to judge `ready`. */
export interface ReadyEventLike {
  source: unknown;
  data: unknown;
  ports: readonly unknown[];
}

/**
 * The port from a genuine `ready`, or null. Genuine = sent by `frameWindow`
 * (the iframe's own contentWindow — never compared by origin), shaped as the
 * bootstrap sends it, carrying exactly one port.
 */
export function acceptReady<P>(event: ReadyEventLike & { ports: readonly P[] }, frameWindow: unknown): P | null {
  if (frameWindow == null || event.source !== frameWindow) return null;
  const data = event.data as { type?: unknown; kind?: unknown; version?: unknown } | null;
  if (!data || typeof data !== "object") return null;
  if (data.type !== PREVIEW_PROTOCOL || data.kind !== "ready" || data.version !== PREVIEW_PROTOCOL_VERSION) {
    return null;
  }
  if (event.ports.length !== 1) return null;
  return event.ports[0] ?? null;
}

const ItemId = z.string().min(1).max(100);

const TtsSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("math"), tex: z.string().max(2_000) }).strict(),
]);

export const TtsRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("speak"),
      id: z.string().min(1).max(200),
      rate: z.enum(["slow", "normal", "fast"]),
      segments: z.array(TtsSegment).max(500),
    })
    .strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
]);
export type TtsRequest = z.infer<typeof TtsRequestSchema>;
export type TtsSegment = z.infer<typeof TtsSegment>;

/** The handlers whose posts the preview ignores (ADR 0019 §5). */
export const IGNORED_HANDLERS = ["upload", "timer", "home", "stt"] as const;

export type FrameMessage =
  | { kind: "response"; item_id: string; response: ItemResponse }
  | { kind: "withdraw"; item_id: string }
  | { kind: "submit" }
  | { kind: "tts"; request: TtsRequest }
  | { kind: "ignored"; handler: (typeof IGNORED_HANDLERS)[number] }
  | { kind: "rendered"; linked: boolean; items: number }
  | { kind: "jump"; item_id: string }
  | { kind: "error"; message: string };

const ResponseBody = z.object({ item_id: ItemId, response: ItemResponseSchema }).strict();
const WithdrawBody = z.object({ item_id: ItemId }).strict();
const SubmitBody = z.object({ confirm: z.literal(true) }).strict();

/** One port message from the frame, validated, or null (dropped). */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  switch (m.kind) {
    case "bridge": {
      const body = m.body;
      switch (m.handler) {
        case "response": {
          const parsed = ResponseBody.safeParse(body);
          return parsed.success ? { kind: "response", ...parsed.data } : null;
        }
        case "withdraw": {
          const parsed = WithdrawBody.safeParse(body);
          return parsed.success ? { kind: "withdraw", item_id: parsed.data.item_id } : null;
        }
        case "submit":
          return SubmitBody.safeParse(body).success ? { kind: "submit" } : null;
        case "tts": {
          const parsed = TtsRequestSchema.safeParse(body);
          return parsed.success ? { kind: "tts", request: parsed.data } : null;
        }
        case "upload":
        case "timer":
        case "home":
        case "stt":
          return { kind: "ignored", handler: m.handler };
        default:
          return null;
      }
    }
    case "rendered":
      return typeof m.linked === "boolean" && Number.isSafeInteger(m.items) && (m.items as number) >= 0
        ? { kind: "rendered", linked: m.linked, items: m.items as number }
        : null;
    case "jump": {
      const parsed = ItemId.safeParse(m.item_id);
      return parsed.success ? { kind: "jump", item_id: parsed.data } : null;
    }
    case "error":
      return { kind: "error", message: typeof m.message === "string" ? m.message.slice(0, 300) : "error" };
    default:
      return null;
  }
}

/** What the renderer reads as page globals, posted once per frame document. */
export interface PreviewPayload {
  bundle: DeliveryBundle;
  /**
   * Always true: nothing in the preview reaches a server, and the renderer's
   * offline labels ("Offline mode: …") are the ones that say so honestly
   * instead of a "Saving…" / "Handing in…" that never resolves.
   */
  offline: true;
  tts_scope: { items: boolean; stimuli: boolean; responses: boolean };
  stt_state: "off";
  katex_macros: Record<string, string>;
}

export function loadMessage(payload: PreviewPayload) {
  return { kind: "load" as const, payload };
}

export function scrollToMessage(itemId: string, smooth: boolean) {
  return { kind: "scroll_to" as const, item_id: itemId, smooth };
}

export type SpeechEvent = "started" | "paused" | "resumed" | "word" | "finished" | "cancelled";

export function speechMessage(
  event: SpeechEvent,
  id: string,
  word?: { segment: number; offset: number; length: number },
) {
  return { kind: "speech" as const, event, id, ...(word ?? {}) };
}
