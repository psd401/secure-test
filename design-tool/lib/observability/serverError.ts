import { createHash } from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionJWT } from "@/lib/auth/session";
import { LOG_TEXT_MAX, log, routeOf, truncate } from "@/lib/log";
import { type ServerErrorEventInsert } from "@/db/schema";

/**
 * Batch 3 slice 2: the body of `onRequestError`, lifted out of
 * `instrumentation.ts` so it can be tested without a Next server.
 *
 * Every unhandled route / server-component error produces exactly two things:
 * one `level: "error"` JSON log line (what the CloudWatch metric filter and
 * the alarm see) and one `server_error_events` row (the record a report reads
 * back). They carry the same fields, joined by `request_id` — the value
 * `proxy.ts` minted and echoed as the `x-request-id` response header, which is
 * also the "ref" the error boundaries put on screen.
 *
 * Neither carries a body, a query string, a header value, or a token: see the
 * redaction contract in `lib/log.ts`.
 */

/** Next 16's `onRequestError` first two parameters, narrowed to what we read. */
export interface ServerErrorRequest {
  path: string;
  method: string;
  headers: { [key: string]: string | string[] | undefined };
}

export interface ServerErrorContext {
  routePath?: string;
  routeType?: string;
  routerKind?: string;
}

/** The single write. Injectable so a test can assert the row without a DB. */
export type ServerErrorWriter = (row: ServerErrorEventInsert) => Promise<unknown>;

export interface RecordServerErrorDeps {
  writeRow?: ServerErrorWriter;
  /** Resolves the signed-in principal from the request headers. */
  resolveSub?: (req: ServerErrorRequest) => Promise<string | null>;
}

function headerValue(
  headers: ServerErrorRequest["headers"],
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The correlation handle. `proxy.ts` mints `x-request-id` on the way in and
 * echoes it on the way out; behind the ALB the trace header is already there
 * and is preferred so a row lines up with an ALB access-log line.
 */
export function requestIdFrom(headers: ServerErrorRequest["headers"]): string | null {
  return (
    headerValue(headers, "x-request-id") ??
    headerValue(headers, "x-amzn-trace-id") ??
    null
  );
}

/**
 * Groups errors that are "the same error" without anyone reading a stack: the
 * first eight frames with absolute paths, line and column numbers and hex
 * addresses flattened, hashed. Two occurrences of one bug hash alike; two
 * different bugs in one file do not.
 */
export function hashStack(stack: string | null | undefined): string | null {
  if (!stack) return null;
  const normalised = stack
    .split("\n")
    .slice(0, 8)
    .map((line) =>
      line
        .trim()
        // Order matters: line:column goes first so the path rewrite below sees
        // a bare file path and reduces it to its basename.
        .replace(/:\d+:\d+/g, "")
        .replace(/(?:file:\/\/)?\/(?:[^\s)/]+\/)+([^\s)/]+)/g, "$1")
        .replace(/0x[0-9a-f]+/gi, "0x"),
    )
    .join("\n");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  // Never JSON.stringify an unknown throw: it can be a request-shaped object
  // and that is how a body ends up in a log line.
  return `non-error thrown: ${Object.prototype.toString.call(error)}`;
}

function digestOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "digest" in error) {
    const d = (error as { digest?: unknown }).digest;
    if (typeof d === "string" && d.length > 0) return d;
  }
  return null;
}

function stackOf(error: unknown): string | null {
  return error instanceof Error && typeof error.stack === "string"
    ? error.stack
    : null;
}

/** Reads `sub` from the cookie or bearer session, or null. Never throws. */
async function defaultResolveSub(req: ServerErrorRequest): Promise<string | null> {
  try {
    const bearer = headerValue(req.headers, "authorization");
    const bearerMatch = bearer ? /^Bearer\s+(.+)$/i.exec(bearer.trim()) : null;
    const token = bearerMatch?.[1]?.trim() ?? cookieToken(req.headers);
    if (!token) return null;
    const session = await verifySessionJWT(token);
    return typeof session.sub === "string" ? session.sub : null;
  } catch {
    // An expired or malformed session is not worth failing the error path for.
    return null;
  }
}

function cookieToken(headers: ServerErrorRequest["headers"]): string | null {
  const raw = headerValue(headers, "cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

async function defaultWriteRow(row: ServerErrorEventInsert): Promise<unknown> {
  // Imported lazily: `instrumentation.ts` is evaluated in the Edge runtime too,
  // where the postgres driver has no business being loaded.
  const [{ getDb }, { server_error_events }] = await Promise.all([
    import("@/db/client"),
    import("@/db/schema"),
  ]);
  return getDb().insert(server_error_events).values(row);
}

/**
 * Writes the line and the row. Resolves even when the database write fails —
 * a 500 whose recording throws would become an unhandled rejection inside
 * Next's error handler, and the log line is the primary record anyway.
 */
export async function recordServerError(
  error: unknown,
  request: ServerErrorRequest,
  context: ServerErrorContext = {},
  deps: RecordServerErrorDeps = {},
): Promise<void> {
  const resolveSub = deps.resolveSub ?? defaultResolveSub;
  const writeRow = deps.writeRow ?? defaultWriteRow;

  const route = routeOf(request.path || context.routePath || "/");
  const method = (request.method || "GET").toUpperCase();
  // Next does not hand `onRequestError` a status: by the time it fires the
  // response is the framework's 500 (or its streamed equivalent).
  const status = 500;
  const message = truncate(messageOf(error), LOG_TEXT_MAX);
  const digest = digestOf(error);
  const stack = stackOf(error);
  const stackHash = hashStack(stack);
  const requestId = requestIdFrom(request.headers);
  const sub = await resolveSub(request).catch(() => null);

  log.error("request_error", {
    route,
    method,
    status,
    digest: digest ?? undefined,
    message,
    stack_hash: stackHash ?? undefined,
    request_id: requestId ?? undefined,
    sub: sub ?? undefined,
    route_path: context.routePath,
    route_type: context.routeType,
  });

  try {
    await writeRow({
      request_id: requestId,
      route,
      method,
      status,
      digest,
      message,
      stack_hash: stackHash,
      stack: stack ? truncate(stack, LOG_TEXT_MAX) : null,
      sub,
    });
  } catch (writeError) {
    log.error("request_error_not_recorded", {
      request_id: requestId ?? undefined,
      reason: truncate(messageOf(writeError), 200),
    });
  }
}
