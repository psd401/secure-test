# UX pass 1 — the design record (2026-08-30)

What the design tool's teacher loop looks like and why, after UX pass 1
(slices 1–10, `docs/ux-pass-1-proposal.md` is the research + slice log; this
file is the durable reference). Scope was the day-one teacher loop: sign-in →
Assessments → authoring → Students (accommodations) → Test sessions → Monitor.
Results / scoring / release screens and the macOS client were out of scope.

## 1. Decisions (James, 2026-08-30)

| # | Decision |
|---|---|
| 1.1 | Page ground **Mist `#F3F8FA`** — the Ocean/Whulge hue at 97.5 % lightness; chosen over Skylight as the most distinct from other in-house PSD apps. |
| 1.2 | Primary action **Cedar `#466857`** (white on it 6.22:1). |
| 1.3 | **Josefin Sans** headings, **Inter** body, both self-hosted via `next/font/google`. |
| 1.4 | **Light only** in pass 1; the `.dark` variant is declared and nothing sets it. A brand dark theme is a later feature, not a token flip. |
| 1.5 | App-shell header is a **Pacific band** with Skylight text and a Sea Glass active-nav underline. |
| 2.1 | Teacher-facing nouns (below); identifiers, API, DB and the client are untouched. |
| 3.1 | Editor tabs live in `?tab=`; `AssessmentEditor.tsx` was not split. |
| 5.4 | Ten slices, one commit each. |
| 3.3 | Scoring queue / Results demoted to a muted "More" row, not hidden. |
| 3.4 | Create-path seeding kept; a seeded question reads as *Incomplete* until rewritten. |
| 3.5 | Publish readiness is a client-side checklist; the server still accepts a publish with gaps (separate proposal). |
| 4.1 | A rostered student with no record is opened through `/dashboard/accommodations/roster/<ps_id>`, which binds/creates the overlay row with the same helper a first join uses. |
| 4.2 | Values are chosen from TIDE's own options client-side; server-side validation is a separate proposal. |

## 2. Tokens (`design-tool/app/globals.css`)

Ratios are WCAG 2.x contrast, computed. "Surface" is the darkest ground the
text sits on in the loop (Sea Foam), so every pair survives Mist, white and
Sea Foam.

| Token | Value | PSD source | Role / evidence |
|---|---|---|---|
| `--background` | `#F3F8FA` | derived from Ocean/Whulge (hue 232) | Page ground. Pacific on it 10.00:1. |
| `--foreground` | `#25424C` | Pacific | Text everywhere (10.70 white · 10.00 Mist · 8.99 Sea Foam). |
| `--card`, `--popover` | `#FFFFFF` | — | Cards, dialogs, tables; always with `--border`. |
| `--primary` / fg | `#466857` / `#FFFFFF` | Cedar | The one filled button per screen (6.22). |
| `--secondary`, `--muted` | `#EEEBE4` | Sea Foam | Secondary fills, table heads, skeletons (1.14 vs page — visible). |
| `--muted-foreground` | `#5A6C73` | Pacific hue, derived | Helper text; 4.61 on Sea Foam (AA on the worst surface). |
| `--accent` / fg | `#EAF3EC` / Pacific | Sea Glass 15 % | Hover / selected wash. |
| `--destructive` / fg | `#A04034` / white | "Clay", derived | Delete / Close buttons and error text (6.41). |
| `--border` | `#CDDADF` | Pacific hue, derived | Hairlines (decorative). |
| `--input` | `#7D888D` | Pacific hue, derived | Field boundary ≥ 3.05 on every surface (1.4.11). Ocean was rejected (2.65 on Sea Foam). |
| `--ring` | `#346780` | Whulge | Focus ring. |
| `--success` / fg | `#E9EDEB` / `#466857` | Cedar tint | Handed in, Open, Published, Saved (5.26). |
| `--warning` / fg | `#F1ECE4` / `#8D5D1C` | "Ochre", derived | Idle, lock banner, review notices (4.81). |
| `--danger` / fg | `#F4E8E7` / `#A04034` | Clay tint | Needs attention, error boxes (5.35). |
| `--info` / fg | `#E7EDF0` / `#346780` | Whulge tint | In progress, progress bars, IEP/504 (5.23). |
| `--neutral` / fg | `#EEF0F1` / `#5A6C73` | Pacific-grey | Not joined, Closed / Ended, Draft (4.80). |
| `--brand` | `#6CA18A` | Sea Glass | Decoration only — nav underline, emblem; fails as text (2.96). |
| `--brand-ink` | `#40745E` | Sea Glass darkened | When a green must carry text (5.42). |
| `--band` / fg | `#25424C` / `#FFFAEC` | Pacific / Skylight | The header band (10.26). |
| `--font-heading` | Josefin Sans | brand | `h1`, the wordmark, stat tiles. |
| `--font-sans` | Inter | sanctioned substitute | Everything read at speed. |

Brand colours that are **not** text on light grounds: Sea Glass (2.96), Meadow
(3.71), Ocean (3.15). Driftwood is not used.

## 3. Glossary — teacher word ↔ identifier

The UI says the left column; code, routes, the API and the database keep the
right column. Do not "fix" one to match the other.

| Teacher sees | Code / API / DB |
|---|---|
| Test session, Start session, Session code | `test_sessions`, `SittingsPanel`, `sitting`, `[sittingId]`, `code` |
| Close session → Closed; Ended (time up) | `POST …/close`; `status = closed`; `open` past `expires_at` |
| Handed in | `status = submitted` (matches the client's "Finish and hand in") |
| Needs attention · Idle · In progress · Not joined | `alert` (sticky, server) → `studentState()` (presentation); `idleFor()`; `in_progress`; `not_joined` |
| Earlier: … | an `alert` postdated by `lockdown_begin` or answer activity (`alertIsCurrent()`) |
| View screen | peek (`/api/attempts/[id]/peek*`, `docs/on-demand-peek-design.md`) |
| Assessments (home), Questions, Add question, Question | `assessments`, `items`, `stem` |
| Multiple choice · Multiple select · Short answer · Essay · Matching · Ordering · Click the image · Drawing | `multiple_choice_single` · `multiple_choice_multi` · `short_text` · `essay` · `match` · `order` · `hotspot` · `drawing_upload` |
| Publish / Unpublish, Draft / Published | `PATCH { status }` (the unlock-only patch `requireDraft` accepts) |
| Settings; Allow AI help when writing questions | metadata PATCH; `allow_llm_authoring` |
| Accommodations (tab); Changes what is measured | `allowed_accommodations`; `construct_altering` |
| Student accommodations (tab); override | `/api/assessments/[id]/overrides` |
| Students (nav); supports; IEP/504 | `/dashboard/accommodations`, `students` overlay, `student_accommodations`; `ospi_tier = accommodation` |
| Import TIDE settings; settings taken from TIDE / you had changed were kept / TIDE no longer lists were turned off | `applyTideImport` counters `rows_overwritten` / `rows_preserved_with_diff` / `rows_soft_removed` |
| Review TIDE changes; Your value / TIDE value; Use TIDE value | `pendingTideDiffs()`, `accept-tide` |
| Images | `/dashboard/uploads`, `assets` |
| Import assessment file / Download backup (.json) | `ItemBundleSchema` import / `…/export?include_hidden_rubrics=1` |

## 4. Shell and states

- One header (`components/app/AppHeader.tsx`) on every `/dashboard` route;
  every page below home starts with a breadcrumb whose last crumb is the h1
  (`components/app/PageHeader.tsx`).
- **Empty**: `EmptyState` — what is missing, what will appear, the CTA inside.
  Never rendered for a failed load: panels model `loading | error | ready`.
- **Loading**: skeletons (`app/dashboard/loading.tsx`, panel skeletons);
  polled views keep the last snapshot and say so (`LiveIndicator`).
- **Error**: `app/dashboard/error.tsx`, `app/not-found.tsx`; every API failure
  is a sentence from `lib/ui/errorCopy.ts` (raw code shown only when the fix is
  IT's); item errors sit inside the failing card.
- **Success**: `StatusLine` (`role=status`, "Saving… → Saved HH:MM") beside
  every Save; one `aria-live` line per live screen.
- **Destructive**: `AlertDialog` naming the object and consequence — Delete
  question, Remove support, Remove override, Close session, Delete image,
  Switch rubric style. No native `confirm()` remains in the loop.

## 5. Accessibility target

Design target: **WCAG 2.2 AA**. Contrast is computed for every token pair
above; focus is the shadcn ring (`border-ring` + 3 px `ring-ring/50`); icon
buttons are ≥ 32 px (`size-8`); status is always icon + word on a tint; live
regions announce saves, refreshes and the needs-attention count. Policy
context (from the research pass, not re-verified here): DOJ Title II binds
public districts to WCAG 2.1 AA from April 2027; WaTech's standard is 2.2 AA.
This tool is staff-facing; the student client is the surface inside the rule.

Known gap left in the loop: `HotspotEditor` region authoring is drag-only
(WCAG 2.2 SC 2.5.7) — pass 2.

## 6. Carried to UX pass 2

- Toasts (Sonner), Radix Select / Checkbox / RadioGroup / Tooltip /
  DropdownMenu, an accordion item list with drag reorder (A-12, A-19).
- A brand dark theme (decision 1.4).
- Server-side publish readiness (3.5); server-side Value validation (ACC-08);
  subject "ANY" (ACC-09); TIDE label alignment with the catalog (ACC-11).
- One live attendance surface (SM-18): the Test sessions tab still polls its
  own table for open sessions.
- Search / filter on Assessments and Students; in-editor image upload; an
  accommodations chip on monitor rows; print session information; per-student
  pin on the monitor; a dedicated Sessions page; a first-run checklist.
- `proxy.ts`'s "server misconfigured" 500 is still text/plain.
- Nothing "says secure out loud" yet (a Locked marker on published
  assessments / session cards).
- Client: the "Your tests" row detail truncation (docs/phase-7-slices.md).
- Seed: "Your tests seed (5 items…)" delivers 6 (fixture, not UX).
- Sub-editor internals (Rubric / Sequence / MatchPairs / Hotspot / ImagePicker
  / MathTranslator / import panels) are on the tokens but still hand-rolled.
- From the 2026-08-31 hand-run (`docs/design-tool-manual-checks.md`, "Findings
  from the 2026-08-31 run"): P2-1 `prompt=select_account` on the Google
  authorize URL; P2-2 `noValidate` / drop `required` on New assessment so the
  app's message shows; P2-3 the Add question default stem as a placeholder or
  selected on focus; P2-4 lock the stem and choice text fields when published;
  P2-5 decide whether "Keep mine" persists across identical TIDE re-imports.
