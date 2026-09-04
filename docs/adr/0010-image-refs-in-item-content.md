# 0010. Image refs in item content — `![alt](asset:<uuid>)` with owner-scoped resolution

- **Status**: Accepted (design-tool side); export bundling for PoC-B **deferred**
- **Date**: 2026-05-21

## Context

Slice 10 added image uploads but the uploaded assets had nowhere to land — items couldn't reference them. Three places need to render images-in-items:

1. The design-tool **editor** (live preview while authoring).
2. The design-tool **preview iframe** (what the teacher sees as "what the student will see").
3. PoC-B's **WKWebView** at test time.

The same CSP / sandbox tensions that ADR 0006 + ADR 0009 surfaced for math apply here: the preview iframe must not need extra capabilities, and PoC-B can't reach the design-tool API at runtime.

## Decision

**Syntax**: markdown-flavored `![alt](asset:<uuid>)` where `<uuid>` is the asset's row id. Reasons:
- Familiar to anyone who's written markdown / Notion / Obsidian.
- The `asset:` scheme is intentionally non-URL — refs never resolve directly through the browser; the server-side renderer always substitutes them. A stem that escapes our renderer (e.g. a future raw-HTML view) won't accidentally render an `<a href="asset:...">` link to nowhere.
- Snake-case-friendly: the rest of the wire format is text and snake_case (ADR 0002), and this syntax preserves stems as text — no schema change.

**Storage**: stems and choice texts stay as text. No new column on `items`. The `assets` table from slice 10 is the asset registry; the items just reference assets by id in stem strings.

**Resolution**: server-side at render time.
- The preview iframe route extracts every referenced uuid from every stem + choice text in the assessment, does a single owner-scoped `select id, content_type from assets where owner_sub = ? and id in (...)`, and passes the resolved map to `renderItemContent()`. Refs not in the map render as inline-red `<span class="image-missing">[image not found: alt]</span>` placeholders. The placeholder copy intentionally leaks no information about whether the asset doesn't exist at all vs. exists but isn't owned — same UX in both cases.
- The editor's live preview uses the same `renderItemContent` via a `renderContent` server action that does the lookup per call. One DB query per debounce fire is the cost; queries are owner-scoped + uuid-indexed so the latency is fine.
- The unified `lib/items/renderItemContent.ts` is the single source of truth for "what does an item body look like": images first (outer split), then math + text within each non-image segment, then HTML-escape everywhere text leaks through.

**Image serving**: the existing `GET /api/assets/[id]` route (slice 10) is what `<img src>` points at. CSP `img-src 'self' data:` already permits this. Same-origin cookies are sent automatically by the iframe, so session ownership is enforced naturally — a student opening the preview iframe URL from a different browser session would 401 on the asset fetch.

**Export to PoC-B**: out of scope. The export route currently emits raw text — including raw `![alt](asset:<uuid>)` syntax — and PoC-B has no resolver. Until the export bundles the binary blobs (e.g. base64 in the JSON, or a sidecar tar) and PoC-B learns to dereference the syntax, image-bearing assessments won't render their images in the macOS client. Items still display correctly modulo the literal markdown text in the stem.

## Consequences

- **Better**: zero schema change, zero new wire-format field, single rendering pipeline, security posture stays anchored at "the assets table is the ACL." Future S3 backing (per ADR 0008) doesn't change anything about this slice — the `/api/assets/[id]` URL is provider-agnostic.
- **Worse**:
  - One DB query per editor debounce fire. Tiny, but observable at scale; if the editor preview ever feels laggy, we can cache asset metadata in the client after the first lookup.
  - Cross-tenant ref UX is dumb-by-design ("image not found") rather than informative ("not owned by you"). That's the right call for security but can confuse a teacher who renamed an asset or who pasted a ref from another account.
  - ~~PoC-B sees literal markdown text in any image-bearing stem.~~ Resolved by Slice 15's export bundling (see below).
- **Escape hatch**: if `![alt](asset:<uuid>)` syntax ever feels too inflexible (e.g. we need width/height hints or alignment), the parser is one regex change away — and the on-wire text stays valid markdown.

## Slice 15 addendum: export bundling

The `ItemBundleSchema` gained an optional `assets: Record<uuid, {content_type, base64}>` field. When the design-tool's export route finds image refs in stems / choices, it gathers the bytes via the storage provider, base64-encodes each, and includes them in `assets`. The response carries an `x-bundled-asset-count` header so the teacher (or a CLI consumer) can see what shipped.

The import path mirrors this:
- Body cap raised from 1 MB to 50 MB (cap on individual assets is still 5 MB at upload time; ten 5 MB images base64-encoded fit comfortably in 50 MB).
- Each `assets` entry is decoded, sha256'd, and either reused (per-owner dedup against the existing `assets` table) or written as a new asset row. The result builds an `incoming-uuid → new-uuid` remap.
- Every stem and choice text in the bundle's items is then rewritten so `![alt](asset:<oldUuid>)` becomes `![alt](asset:<newUuid>)` before insertion. Both the JSON-body API route and the dashboard server-action page share `lib/api/importBundle.ts` so the remap logic doesn't drift between paths.

PoC-B side: the Swift `ItemBundle` gained an optional `assets: [String: BundleAsset]?` field. The inline JS in `TestRunner.swift` runs a tokenizer (matching the `![alt](asset:<uuid>)` regex) that builds DOM fragments per stem / choice text: each ref becomes an `<img src="data:<content_type>;base64,<base64>">` from the bundle map, or an inline-red `[image not found: alt]` span if the ref isn't in the map. The CSP gained `img-src data: 'self'` to permit the data: URIs. The DOM-fragment approach (vs `innerHTML`) keeps the safety property — alt text goes through `element.alt = ...` which the browser attribute-escapes.

The end-to-end result: a teacher exports an image-bearing assessment, drops the JSON into PoC-B's `items.json`, rebuilds the app, and the image renders inline at student-test time without any network access.

## TODO: follow-ups (post-slice-15)

- [x] ~~**Export bundling for image-bearing assessments.**~~ Done in Slice 15.
- [ ] **Cache asset metadata in the editor client** so the per-debounce DB lookup goes away once the picker has loaded the list.
- [ ] **Image size / dimensions in the picker** so teachers don't blindly drop in a 5 MB photo when a thumbnail would do. Re-encoding / thumbnailing is a separate ticket.
- [ ] **Drag-and-drop into the stem textarea** as a faster path than the picker. Deferred until the basic flow is in use.
- [ ] **Streamed asset upload** for very-large assessments. The 50 MB body cap is plenty for typical use; a future "import a textbook's worth of items" workflow would want either multipart-streaming or a sidecar (.tar/.zip) flow.
