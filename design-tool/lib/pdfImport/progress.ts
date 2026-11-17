// PDF / Word import progress (A1, 2026-11-17). The import route can stream
// what it is doing as newline-delimited JSON (NDJSON) when the request
// sends `Accept: application/x-ndjson`, so the teacher sees each step of
// the import instead of one long "Working…". Without that header the route
// answers exactly as before (one JSON body).
//
// One event per line:
//   {"type":"step","step":"read","state":"done","detail":{...}}
//   {"type":"result", ...the route's usual success body}
//   {"type":"error","status":422, ...the route's usual error body}
// The last line is always a result or an error.

export const IMPORT_STEPS = ["read", "figures", "numbering", "ai", "safety", "checks"] as const;
export type ImportStepId = (typeof IMPORT_STEPS)[number];
export type ImportStepState = "active" | "done" | "skipped";

export interface ImportStepDetail {
  pages?: number;
  scanned?: boolean;
  word?: boolean;
  figures?: number;
  expected?: number | null;
  proposed?: number;
  found?: number;
  missing?: number[] | null;
}

export interface ImportStepEvent {
  type: "step";
  step: ImportStepId;
  state: ImportStepState;
  detail?: ImportStepDetail;
}
export type ImportResultEvent = { type: "result" } & Record<string, unknown>;
export type ImportErrorEvent = { type: "error"; status: number } & Record<string, unknown>;
export type ImportEvent = ImportStepEvent | ImportResultEvent | ImportErrorEvent;

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

export function wantsImportStream(accept: string | null | undefined): boolean {
  return (accept ?? "").toLowerCase().includes(NDJSON_CONTENT_TYPE);
}

export function encodeImportEvent(event: ImportEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function createImportEventParser() {
  let buffer = "";
  const parse = (line: string): ImportEvent | null => {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    const value: unknown = JSON.parse(trimmed);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !["step", "result", "error"].includes((value as { type?: unknown }).type as string)
    ) {
      throw new Error("The import sent a progress line it could not read.");
    }
    return value as ImportEvent;
  };
  return {
    push(chunk: string): ImportEvent[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.map(parse).filter((e): e is ImportEvent => e !== null);
    },
    end(): ImportEvent[] {
      const rest = buffer;
      buffer = "";
      const last = parse(rest);
      return last ? [last] : [];
    },
  };
}

export function eventBody(event: ImportResultEvent | ImportErrorEvent): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  if (event.type === "error") {
    const { status: _status, ...body } = rest as Record<string, unknown>;
    return body;
  }
  return rest;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function importStepLabel(step: ImportStepId, state: ImportStepState, detail: ImportStepDetail = {}): string {
  const active = state === "active";
  switch (step) {
    case "read":
      if (active) return "Reading the file";
      if (detail.word) return "Read the Word document";
      return `Read ${plural(detail.pages ?? 0, "page")}${detail.scanned ? " (a scan, so the AI reads the page pictures)" : ""}`;
    case "figures":
      if (active) return "Finding pictures and preparing the pages";
      return detail.figures ? `Found ${plural(detail.figures, "picture")}` : "No pictures found";
    case "numbering":
      if (active) return "Counting the numbered questions";
      return detail.expected ? `The document numbers ${plural(detail.expected, "question")}` : "No question numbers found to check against";
    case "ai":
      if (active) return "AI is reading the test";
      return `AI proposed ${plural(detail.proposed ?? 0, "question")}`;
    case "safety":
      return active ? "Safety check on the proposed questions" : "Safety check passed";
    case "checks": {
      if (active) return "Checking the proposed questions";
      const expected = detail.expected ?? 0;
      const found = detail.found ?? 0;
      if (expected > 0 && detail.missing && detail.missing.length > 0) {
        return `Found ${found} of ${expected} numbered questions; missing ${detail.missing.join(", ")}`;
      }
      if (expected > 0 && detail.missing) return `Found all ${plural(expected, "numbered question")}`;
      if (expected > 0 && found < expected) return `Found ${found} of ${expected} numbered questions`;
      return `${plural(found, "question")} ready for review`;
    }
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
