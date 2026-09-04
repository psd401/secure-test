# 0006. Preview iframe — sandbox attributes + CSP posture

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

Slice 6 added a teacher-facing preview of an assessment, embedded in the editor at `/dashboard/[id]`. The preview renders the same item shape PoC-B's `LockedDownWebView` shows to students. Two security questions:

1. **What can the preview iframe do?** It's loaded same-origin from `/preview/[id]` and the parent page is also same-origin, so by default it could read the parent's cookies via DOM access, execute scripts that mutate the parent, etc.
2. **How locked-down should the preview HTML itself be relative to PoC-B's runtime CSP?** PoC-B's WKWebView CSP is `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`. The `script-src` allowance is there because PoC-B's HTML includes inline JS that posts answers back via `window.webkit.messageHandlers.response.postMessage`. The design-tool preview has no such handler — it's purely visual.

## Decision

**Iframe attributes:**
- `sandbox="allow-same-origin"` — disables script execution, top-level navigation, popups, form submission, plugin instantiation. Allows same-origin so the iframe can be styled and inspected from the parent's devtools (and so the route handler's CSP applies via its origin policies). No `allow-scripts`.
- `referrerpolicy="no-referrer"` — defense in depth.

**Preview-route CSP** (set as both a response header and an `<meta http-equiv>` tag inside the document):
- `default-src 'none'` — nothing is allowed by default.
- `style-src 'unsafe-inline'` — matches PoC-B; the inline `<style>` block is the only styling source.
- `img-src 'self' data:` — anticipates inline base64 images and same-origin image uploads in a later slice.
- `frame-ancestors 'self'` — the preview can only be embedded by the design-tool itself (clickjacking defense).
- **No `script-src` at all** — the preview has no inline script, so removing the allowance shrinks the surface vs. PoC-B's runtime CSP.

The rendered HTML is static: `lib/preview/renderHtml.ts` emits markup only (radio inputs, checkbox inputs, text inputs — all `disabled`). All choice inputs are non-interactive; the preview is intentionally read-only because the goal is "show the teacher what the layout looks like," not "let the teacher take their own test."

## Consequences

- **Better**: zero JavaScript in the preview means zero risk of an injected stem string smuggling code into the iframe context. The iframe's `sandbox` minus `allow-scripts` makes that property load-bearing rather than aspirational. The CSP posture is strictly tighter than PoC-B's runtime — when we later port the preview HTML pattern into PoC-B's `renderHTML()`, we can drop `script-src` there too if PoC-B switches to native answer capture.
- **Worse**: the preview can't reproduce PoC-B's sandbox-escape probes (those required JS). That's fine — those probes were PoC-B-specific instrumentation, not part of student UX. If we ever need a "test posture" view, it would be a separate page, not the preview.
- **Escape hatch**: if a future item type genuinely needs runtime JS (e.g. interactive math input), this ADR is superseded by a new one that re-adds `script-src 'unsafe-inline'` and uses `sandbox="allow-scripts"` for the iframe — but the surface area should be examined fresh at that point.
