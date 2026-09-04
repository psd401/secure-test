/**
 * Post-login redirect target validation.
 *
 * The `next` param travels from `/api/auth/start` into the signed PKCE cookie
 * and is finally resolved as `new URL(next, origin)` by the callback route.
 * `new URL()` treats a backslash exactly like a forward slash, so a value such
 * as `/\evil.com` resolves to `https://evil.com/` — an open redirect. Validate
 * by resolving against a sentinel origin and confirming the result stayed on it.
 */

// Any absolute origin works here; we only ever accept values that resolve back
// onto it, so the real request origin is irrelevant.
const SENTINEL_ORIGIN = "https://design-tool.invalid";

/**
 * C0 controls, space, and DEL. The WHATWG URL parser silently strips tab/LF/CR
 * and trims leading/trailing C0-or-space, so these must be rejected up front
 * rather than parsed.
 */
function hasForbiddenChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Returns a normalized same-origin path, or `undefined` when the value is not a
 * safe relative destination. Callers must fall back to a known-good default.
 */
export function safeNextPath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (hasForbiddenChars(value)) return undefined;
  // Browsers and WHATWG URL normalize "\" to "/", so "/\evil.com" is
  // protocol-relative in disguise. Reject rather than rewrite.
  if (value.includes("\\")) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;

  let resolved: URL;
  try {
    resolved = new URL(value, SENTINEL_ORIGIN);
  } catch {
    return undefined;
  }
  if (resolved.origin !== SENTINEL_ORIGIN) return undefined;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
