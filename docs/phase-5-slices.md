# Phase 5 — the macOS student client

Slices 51-73, built and pushed 2026-08-25 (`505b424..6e05d75`). Follows the same
shape as `docs/phase-{2,3,4}-slices.md`.

**Phase numbering warning.** This is Phase 5 in the DESIGN-TOOL's sequence
(phases 1-4 built the authoring app). `docs/plan.md` has its own, older Phase 1-4
— MVP / OneRoster / anomaly+thumbnails / LTI — so "Phase 3" means two unrelated
things depending on which document you are in. Worth reconciling.

## What it produced

A macOS student client at `client/` that joins a sitting by code, is resolved to
its roster row, receives a bundle carrying that student's own accommodations,
renders and answers all eight item types, spools every answer to disk before
sending it, uploads drawings, and hands the test in. Plus the entire server-side
student plane in `design-tool/`, which did not exist before.

Two things it deliberately does NOT do, both blocked externally: enter an
`AEAssessmentSession` (no entitlement), and sign a student in (no ClassLink
`client_id`).

## Groups

The work was scoped as three groups. A and B were approved first; C was approved
separately after a plan.

- **A — make the wire student-safe** (51)
- **B — client and renderers** (52-57)
- **C — the student plane** (58-69), gated on a security review
- **Cleanup** (70-73), from the review and from items flagged along the way

## Slices

| # | Commit | What |
|---|---|---|
| 51 | `072b767` | `DeliveryBundleSchema` — a student wire type with no field that can hold an answer key |
| 52 | `51479a1` | `client/` scaffold: Xcode app + `SecureTestCore` package; PoC-B hardening ported |
| 53 | `c403f92` | Item model as a Swift enum; decode all 8 types; MC + short text render |
| 54 | `6edccdf` | Essay renderer, and a JavaScriptCore harness that made the renderer testable |
| 55 | `53338c4` | Match renderer |
| 56 | `6807421` | Order renderer |
| 57 | `5bab322` | Hotspot renderer |
| 58 | `800fd38` | Role enforcement across every route; bearer credentials |
| 59 | `014bd00` | ClassLink identity bridge on the roster (migration 0012) |
| 60 | `94e79a8` | Test sittings with auto-expiring join codes (0013) |
| 61 | `339c68e` | Attempt and response ingest (0014) |
| 62 | `91a61da` | Effective accommodations reach students; delivery requires a student |
| 63 | `546a86c` | Override precedence by `assigned_scope` (0015) |
| 64 | `6ca5a55` | Per-attempt sealed option ids for match and order |
| 65 | `0170b5f` | Student file uploads (0016) |
| 66 | `941b15a` | Client network layer, Keychain token, join screen |
| 67 | `1f87926` | SQLite offline spool |
| 68 | `49d656c` | Drawing renderer — the last item type becomes answerable |
| 69 | `8e49acc` | Per-assessment clipboard policy (0017) |
| — | `d7ab41e` | Security review fixes (see below) |
| 70 | `b319ca0` | An unbundleable item is reported, not thrown |
| 71 | `27dcead` | Docs brought current |
| 72 | `6811a65` | PoC-B's three untested hardening gaps closed |
| 73 | `6e05d75` | Spool clear + hand-in, upload reclamation, delivery-secret warning |

Migrations 0012-0017. No slice 71 code commit — it was the docs pass.

## Decisions that are not obvious from the code

- **Two wire formats, never merged** (ADR 0016). `ItemBundleSchema` carries answer keys
  because teacher-to-teacher share round-trips through the import route.
  `DeliveryBundleSchema` has nowhere to put one. A single format with a
  strip-on-the-way-out flag was rejected: the safe default for one audience is
  the lossy default for the other.
- **Match and order needed a shape change, not a deletion** (ADR 0016). The pairing IS the
  key and the sequence IS the key, so slice 51 split them into independent
  arrays and slice 64 gave the options per-attempt HMAC-derived ids. Slice 51
  could not finish the job because the ids need an attempt to anchor to, and
  attempts did not exist until 61.
- **Three renderers rejected the conventional interaction on accessibility
  grounds** — drag-and-drop for match, drag-to-reorder for order,
  click-the-image for hotspot. Each would have left AT-dependent students unable
  to answer, which in a product built around a 55-entry accommodations catalog
  is not a hypothetical.
- **Unknown ClassLink roles resolve to staff, not denied** — ownership already
  gates staff a second time, and denying would lock out legitimate titles nobody
  anticipated. Safe only because students are matched FIRST and by substring.
- **Response writes are gated on `attempts.status`, not on the sitting.** A
  sitting expiring mid-sentence must not discard the sentence.
- **One attempt per (student, assessment).** Joining a second sitting resumes.
- **Clipboard defaults locked, and absence of the flag means locked** at every
  layer, so an older client or server fails closed.

## Security review

Ran after slice 58 (the role change) and again over the whole group. Findings and
fixes are in `d7ab41e`:

1. `presignPut` signed `ContentLength: max_bytes`, which S3 treats as exact — so
   the direct-upload path could never complete AND the documented cap capped
   nothing. Fixed by declaring the size, capping the declaration, signing the
   declaration. **A presigned PUT cannot express a maximum; do not "fix" a
   SignatureDoesNotMatch by deleting ContentLength.**
2. `/api/test-sessions/redeem` answered `not_on_roster` for a live code and
   `session_unavailable` for a dead one — an oracle letting any authenticated
   student enumerate running sittings. Collapsed; the real reason is logged.

Three items were recorded below the bar and closed later in slice 73.

## What is verifiable, and what is not

`swift test` covers `SecureTestCore` and `bun test` covers `design-tool`. The
AppKit and WebKit surface — drag destinations, Touch Bar, auxiliary web views,
file pickers, the menu bar — cannot be tested here: no window server, and
headless browsers hang (ADR 0013). `client/MANUAL-CHECKS.md` is the hand-check
list that stands in, the same way PoC-B verified its own hardening.

Final counts: 752 design-tool, 85 schema, 147 SecureTestCore.

## Still open

- **AAC entitlement** — requested 2026-05-19, no reply. Now the critical path:
  everything around it is built. `docs/unblock-checklist.md` has the day-of steps
  for both PoC-A and `client/`.
- **ClassLink `client_id`** — sign-in stubbed on both the staff and student side.
- **Hardware function keys** (Mission Control, Spotlight, Dictation) — OS-level,
  which is what AAC exists to take away.
- **Jamf PPPC profile** — deferred to IT.
