# UX pass 1 — proposal (2026-08-30)

Status: **APPROVED 2026-08-30 (James: 1.1 Mist, 1.2 Cedar, 1.3 ok, 1.4 light-only, 1.5 Pacific band, 2.1, 3.1, 5.4 ten slices as listed). Slice 1 built the same day; see §7.** Output of a read-only research + audit
workflow (`wf_72bd225c-d6e`, 11 agents: 4 research, 4 code audits, 2
synthesis lenses, 1 critic/merger). Charter: `docs/phase-7-slices.md`
"UX pass 1 — Phase 2 close-out". Scope is the day-one teacher loop only:
sign-in → dashboard → authoring → accommodations → sittings → monitor + peek.
Results/scoring/release screens and the macOS client are out. Every claim
below traces to a file:line in `design-tool/` or a cited source; the full
agent output (605 KB) is in the session's workflow transcript.

## 0. One defect worth knowing before anything else

**The design tool has only ever rendered its DARK grayscale palette.**
`app/globals.css:23-31` nests `@theme` inside
`@media (prefers-color-scheme: dark)`, which Tailwind v4 does not support;
the built chunk (`.next/dev/static/chunks/design-tool_app_globals_*.css:111`
and `:140`) carries `--color-background: #0a0a0a` under `:root` and **no light
value at all**. Every teacher sees `#0a0a0a` / `#fafafa` regardless of OS
setting. The "friendlier look" motivation is partly this. Slice 1 retires it.

## 1. Visual direction

Calm Pacific-Northwest, not tan: warm **Skylight** page, white cards with a
hairline, one **Cedar** action per screen, Pacific text, status in ochre and
clay instead of Tailwind amber/red. Driftwood is not used anywhere.

### 1.1 Page ground (one CSS variable; decide in Chrome after slice 1)

| Option | Page | Cards | Pacific text | Notes |
|---|---|---|---|---|
| **Skylight (recommended)** | `#FFFAEC` | `#FFFFFF` | 10.26 (AAA) | Literal brand colour; warm without being tan. Cards need `--border` (1.04 vs page). |
| Mist (alternate) | `#F3F8FA` | `#FFFFFF` | 10.00 (AAA) | Ocean/Whulge hue at 97.5% lightness (`oklch(0.975 0.006 232)`); cool blue-grey, distinct from other PSD projects. |
| White + Sea Foam bands (fallback) | `#FFFFFF` | `#EEEBE4` | 10.70 / 8.99 | Brand's own UI default; least distinctive. |

All other tokens were sized against Sea Foam (the darkest surface text sits on),
so the ground can be swapped without re-checking anything.

### 1.2 Semantic tokens (shadcn names → PSD colours; ratios computed, WCAG 2.x)

| Token | Light | Source | Use / evidence |
|---|---|---|---|
| `--background` | `#FFFAEC` | Skylight | Page ground |
| `--foreground` | `#25424C` | Pacific | Text: 10.70 white / 10.26 Skylight / 8.99 Sea Foam |
| `--card`, `--popover` | `#FFFFFF` | white | Cards, dialogs, tables |
| `--primary` | `#466857` | Cedar | The one primary button per screen; white on it 6.22 (AA). Sea Glass cannot be primary (white on it 2.96). |
| `--secondary`, `--muted` | `#EEEBE4` | Sea Foam | Secondary fills, table headers, skeletons (1.14 vs Skylight — visible; a lighter tint at 1.05 vanished) |
| `--muted-foreground` | `#5A6C73` | Pacific hue, derived | Helper text: 5.49 / 5.26 / 4.61 (AA on every surface); today's `#767676` is 4.36 on Skylight (fails) |
| `--accent` | `#EAF3EC` | Sea Glass 15% | Hover/selected wash (1.09 vs Skylight — registers) |
| `--destructive` | `#A04034` | "Clay", derived (palette has no red) | Delete/Close confirm buttons; 6.41 with white text |
| `--border` | `#CDDADF` | Pacific hue, derived | Card edges/dividers (decorative) |
| `--input` | `#7D888D` | Pacific hue, derived | Field boundary: ≥3.05 on every surface (WCAG 1.4.11). Ocean was rejected: 2.65 on Sea Foam. |
| `--ring` | `#346780` | Whulge | 2px focus ring + 2px offset, one rule for all controls |
| `--success` / fg | `#E9EDEB` / `#466857` | Cedar tint | Handed in, Open session, Saved (5.26) |
| `--warning` / fg | `#F1ECE4` / `#8D5D1C` | "Ochre", derived | Idle, published-lock banner (4.81); replaces amber-700-on-amber-500/20 (4.32, fails) |
| `--danger` / fg | `#F4E8E7` / `#A04034` | Clay tint | Needs attention (5.35) + Clay left border on the row |
| `--info` / fg | `#E7EDF0` / `#346780` | Whulge tint | In progress, progress bar (5.23) |
| `--neutral` / fg | `#EEF0F1` / `#5A6C73` | Pacific-grey | Not joined, Closed/Ended (4.80) |
| `--brand` | `#6CA18A` | Sea Glass | Decoration only: mark, active-nav underline on the Pacific band (3.62, passes 3:1 UI), empty-state art. Never text. |
| `--brand-ink` | `#40745E` | Sea Glass darkened | When a green must carry text (5.42 white) |
| `--font-heading` | Josefin Sans | brand | h1/h2 + wordmark, ≥600 weight, ≥20 px |
| `--font-sans` | Inter | sanctioned substitute | Body, forms, tables (Josefin Slab is a display face; low x-height at 13–16 px) |
| mono | system stack | — | Session codes, SSIDs |

Brand colours that FAIL as text on light grounds (computed): Sea Glass 2.96,
Meadow 3.71, Ocean 3.15 on white. They are surface/decoration colours.

### 1.3 Shell and tone

- Persistent header (`app/dashboard/layout.tsx`, new): Pacific band, PSD mark +
  "Secure-Test" in Josefin Sans, nav **Assessments · Students**, staff email +
  Sign out. Today `app/layout.tsx:14-18` renders a bare `<body>` and every page
  hand-rolls a different `← ` back link (10 of them).
- Breadcrumb under the header on every page below home; last crumb = the h1.
- Dark mode: **light only in pass 1**, `color-scheme: light`, `.dark` variant
  declared but no `.dark` block. A brand dark theme is a second palette (Cedar
  and Whulge fail as text on Pacific-dark surfaces; Sea Glass becomes the text
  hue) — pass 2 if wanted. No WCAG criterion requires one.
- Session code is the hero wherever it appears (mono, tracking-widest; 2xl in
  rows, 5xl in the monitor header, ~20 vh in a "Show code" projector dialog).

## 2. Structure

### 2.1 Navigation
- Home = **Assessments**: an "Open now" strip of open sessions (code ·
  assessment · closes at · Monitor · Show code) above the list —
  `GET /api/test-sessions` without `assessment_id` already returns them
  (`app/api/test-sessions/route.ts:38-61`). Today sessions and the monitor are
  unreachable from the dashboard (blocker SH-01).
- Inside an assessment: shadcn Tabs bound to `?tab=questions|settings|
  accommodations|students|sessions` via `router.replace` (reload/Back/deep
  links restore the tab; no split of the 1,613-line `AssessmentEditor.tsx`).
- Scoring queue / Results: demoted to a muted "More" row (routes exist; not
  removed). Dedicated Sessions page and first-run checklist: pass 2.

### 2.2 Terminology (teacher-facing labels only; identifiers, API, DB, client untouched)

| Today | Proposed | Why |
|---|---|---|
| Sitting / New sitting | **Test session** / **Start session** | Cambium TA Interface (WA SBAC), NWEA, CAASPP all say "test session"; the API already says `test_sessions`. "Sitting" is NAPLAN/GCSE usage. |
| code | **Session code** | Cambium "Session ID", Schoolnet "Passcode"; "code" collides with "Choice id" |
| Close sitting | **Close session** + confirm dialog | Server lets in-progress students finish (`lib/api/studentAttempt.ts:118-125`), so "close the door" is accurate; "End" overstates |
| open / closed / expired | Open / Closed / **Ended (time up)** | "expired" is a system word |
| Submitted | **Handed in** | The client's button is "Finish and hand in" (`AssessmentPage.swift:666`) — one word for teacher and class |
| alert (red pill) | **Needs attention** group + factual event chip; demoted to "Earlier: Quit the app · 25 min ago" once a later `lockdown_begin` contradicts it | Cambium "Tests with potential issues"; GoGuardian clears on return; presentation-only — server's sticky rule untouched |
| Peek | **View screen** (privacy line BEFORE the click) | GoGuardian "Student View" |
| Signed in as `<sub>` | staff email | `session.email` is on the payload (`lib/auth/session.ts:14`) |
| Your assessments / Design Tool | Assessments / Secure-Test | nav noun = h1 |
| Uploads / Import JSON / Export JSON | Images / Import assessment file / Download backup (.json) | name what it does |
| Assessment metadata / Save metadata | Settings / Save settings | developer word |
| Status select + Save to publish | **Publish** / **Unpublish** buttons, Draft/Published badges | a select value is not a verb (A-09) |
| Edit / Per-student overrides / Sittings (tabs) | Questions / Settings / Accommodations / Student accommodations / Test sessions | "overrides" is an API word |
| Items / Add item / Stem | Questions / Add question / Question | Google Forms, Formative, Edulastic all say "question" |
| Allow LLM-assisted item authoring | Allow AI help when writing questions (in Settings) | not teacher vocabulary |
| Accommodations (nav) | **Students**, with accommodations per student | roster is the object teachers recognise |
| Add manual accommodation / N accommodations | Add support / "N supports on" (+ "IEP/504: N") | today's count includes every TIDE "Off" row (ACC-02) |
| TIDE importer counters ("rows soft-removed", "catalog drift") | TIDE's own words (Student Settings, Tool, Value) | importer internals |
| `state_mismatch` etc. on login | mapped sentences, raw code in muted text | GOV.UK / NN/g error copy |
| Loading… / Working… | skeletons; spinner in the busy button; "Saving… → Saved HH:MM" | 0 `role=status` today |

### 2.3 States policy
- **Empty**: one `EmptyState` (over shadcn `empty`): icon, what is missing, what
  will appear, CTA inside. Never render "empty" for a failed load (SM-04):
  model `loading | error | ready` explicitly in SittingsPanel and MonitorView.
- **Loading**: `app/dashboard/loading.tsx` skeleton (all pages are
  `force-dynamic`; Aurora can take seconds to resume); polled views keep the
  last snapshot and say "Last update failed at HH:MM — retrying".
- **Error**: `app/dashboard/error.tsx` + `app/not-found.tsx`; one
  `lib/ui/errorCopy.ts` map (code → teacher sentence, raw code in Details);
  never a raw `${status} ${body}` string (9 `text.slice(0` sites today).
- **Success**: `role=status` line beside each Save/Start/Close; one
  `aria-live=polite` region per live screen (WCAG 4.1.3).
- **Destructive**: shadcn AlertDialog naming the object and consequence,
  replacing 5 native `confirm()` calls and the unguarded Close session.
- **Focus/targets**: one 2px Whulge ring; icon buttons ≥24×24 (WCAG 2.2 2.5.8).

### 2.4 Component set (frugal)
shadcn: Button, Input, Textarea, Label, NativeSelect, Card, Badge (+ status
variants), Alert (+ warning), Tabs, Dialog, AlertDialog, Table, Empty,
Skeleton, Breadcrumb, Separator.
Custom (`components/app/`): AppHeader, PageHeader, StatusBadge, SessionCode +
ShowCodeDialog, ProgressBar, LiveIndicator, StatusLine, EmptyState,
PreviewFrame, PublishDialog, NextStepCard, MonitorSummary, ViewScreenDialog;
`lib/ui/errorCopy.ts`, `lib/ui/format.ts`.
Deferred to pass 2: Sonner/toasts, Sheet, Radix Select, Tooltip, DropdownMenu,
Accordion item list + drag reorder, Checkbox/RadioGroup, Progress, Combobox.

## 3. Slices (ordered; one commit each; Chrome hand-check per slice)

The exit criterion (author → session → monitor without a walkthrough) is
reachable after slice 7; 8–10 can slip without blocking the pilot.

| # | Slice | Closes | Exit check (hand-run in Chrome unless noted) |
|---|---|---|---|
| 1 | **Foundation**: tokens, fonts, light-only theme, shadcn primitives; no screen JSX changes. `bun add radix-ui class-variance-authority lucide-react tailwind-merge@^3`, `-d tw-animate-css`; `bunx --bun shadcn@latest add … --dry-run` first and STOP unless paths print `new-york-v4`; rewrite `globals.css` to `:root` + `@theme inline` (KaTeX import kept), delete the nested `@media { @theme }`; `app/fonts.ts` (Josefin Sans + Inter via `next/font/google`); keep the five legacy `--color-*` names resolving so the 312 existing `var(--color-*)` lines work until slice 9. | dark-only build; SH-17, SM-12 (tokens), a11y recs | With macOS Appearance = Dark, all six loop pages render LIGHT (Skylight ground, Pacific text, Josefin h1, Cedar buttons, selects not inverted); `grep -- '--color-background' .next/dev/static/chunks/*globals*.css` shows Skylight and no `#0a0a0a`; `bun run typecheck` + `bun test` pass; tailwind-merge 3.x in `bun pm ls`. James flips `--background` to Mist once and records 1.1. |
| 2 | **App shell, identity, sign-in surfaces, titles**: `app/dashboard/layout.tsx` + AppHeader + PageHeader/Breadcrumb; email in header; `app/page.tsx` redirects; login error map; `proxy.ts` student-role → `/login?error=student_account` page with Sign out (today a text/plain 403); remove the 10 `← ` links; per-page `<title>`; PSD favicon. | SH-02..05, SH-12..15, SH-18, SH-19, ACC-04 | Same Pacific header on every `/dashboard/*` page with the psd401.net email; breadcrumb last crumb = h1; tab titles `… · Secure-Test`; demo student account sees the branded page; `grep -rn '← ' app` = 0; MANUAL-CHECKS sign-in rows still pass. |
| 3 | **Assessments home**: Open-now strip, Table rows with Draft/Published + "Open session · CODE" badges + question count; Create lands IN the editor (today it returns to the list, SH-07); `useActionState` field errors; teacher copy on Import/Images; `loading.tsx` / `error.tsx` / `not-found.tsx`; EmptyState. | SH-01 (blocker), SH-06..11, SH-16, SM-01 | Open session shows in the strip with a working Monitor link; blank name shows "Give the assessment a name" under the field and keeps the other values; stop Postgres → skeleton then error page with Try again. |
| 4 | **Editor structure**: PageHeader with **Publish** dialog (readiness checklist) / Unpublish; `?tab=` Tabs; preview moved inside Questions as a collapsible card; Settings tab (name, description, time limit, AI toggle — `allow_llm_authoring` is already PATCH-able, `lib/api/assessments.ts:41`); Accommodations tab; NextStepCard "Publish to start a test session" → "Start a test session". | A-01..04, A-09, A-10 (blocker), A-14, A-20 | Draft → Publish opens a checklist → badge flips, inputs lock, Next-step lands on the Test sessions tab; reload keeps `?tab=`; arrow keys move between tabs. Hand-run 3.2 (A-07) first. |
| 5 | **Editor feedback**: inline per-card errors via errorCopy; "Saving… → Saved"; dirty state + `beforeunload`; optimistic add/remove (fixes A-07 either way); real placeholders instead of persisted "New question"/"Choice A" (gated on 3.4); "Incomplete" badge feeding the Publish checklist; Delete question → AlertDialog, moved away from ↑/↓; icon buttons ≥24 px with aria-labels; static letter labels instead of the editable choice-id; import/AI panels behind Dialogs. | A-05..08, A-11..13, A-15..18 | Add question appends an empty card with the cursor in it and no reload; a save error appears inside that card only; `grep -c 'confirm('` = 0 in `[id]/`; VoiceOver reads "Mark choice A as correct". |
| 6 | **Test sessions panel**: noun swap; Start-session Card with duration presets (This period · 55 / 90 / Rest of day) and a live "closes at HH:MM"; Start disabled when the teacher has zero sections, with the PowerSchool-6 AM copy; explicit load/error state (no false "No sections on your roster" on a failed fetch, SM-04); separate error channels; Close → AlertDialog; SessionCode hero + Copy + **Show code** projector dialog; attendance → Table. | SM-03/04/06..09, SM-16..19 | "55 min" shows the close time before Start; Show code fills the screen with name + code + join line, legible from 3 m mirrored; kill the API and reload → one error with Retry; `grep -in sitting SittingsPanel.tsx` matches only identifiers. |
| 7 | **Monitor + View screen**: header/code/Close render from server props before the first fetch (SM-05); polling never stops on an error; five stat tiles as filters (Needs attention · Idle · In progress · Not joined · Handed in); grouped Table instead of the 3-up card grid; current-vs-earlier alert rule (presentation-only); lobby EmptyState with the code; "View screen" with helper before the click and Requested / Arrived / No answer badges; Dialog with focus trap/Esc (today `fixed inset-0`, no aria-modal, `MonitorView.tsx:344-377`); `aria-live` announcements. | SM-05, SM-10, SM-11, SM-13, SM-14, SM-20 | Three demo students, one quits and rejoins: it sits under In progress with an "Earlier: …" chip; one that quit is first under Needs attention with the Clay border; stop the dev server → "Last update failed — retrying" with rows still on screen. Re-run the 8.5 + peek MANUAL-CHECKS rows with the real locked client. **Completes the charter exit path.** |
| 8 | **Students (accommodations)**: rename; every roster row reachable (today only students with an overlay row link — blocker-adjacent ACC-01, needs 4.1); honest "N supports on" counts (`isEnabledValue`); IEP/504 signal; TIDE-language import + review; list-first student page with Add support Dialog whose Value is a select from the TIDE catalog (ACC-08: today typing "No" turns a tool ON); Remove → AlertDialog; OverridesPanel CTA points at a tab that exists (SM-15). | ACC-01..07, ACC-10, ACC-13..16, ACC-18, SM-15 | Rostered student not in TIDE opens and saves a support; all-Off demo student reads "0 supports on"; re-import after an edit shows "N changes to review"; DB tests pass on the test database. |
| 9 | **Sweep**: codemod `[var(--color-*)]` → semantic classes; residual primitive swaps in the sub-editors; delete every `dark:`; `.math-error` on tokens; drop legacy names; `accent-color: var(--primary)` for native checkbox/radio. No IA/copy changes. | residue of SH-17 / SM-12 / A-16 / ACC-14 | `grep -rc 'var(--color-' app` = 0 outside scoring/results; `grep -rn 'dark:\|border-dashed\|focus:ring-1\|Loading…' app` = 0 there; visual parity walk. |
| 10 | **Hand-run rows + glossary + pass-2 ledger** (docs only): `docs/design-tool-manual-checks.md` (13" MacBook + mirrored 1080p rows, incl. a fresh-eyes colleague doing create → publish → start → monitor → close), `docs/ux-pass-1.md` (ground decision, token table, glossary teacher-word ↔ identifier, WCAG 2.2 AA target, pass-2 list), update `phase-7-slices.md` + `CLAUDE.md`. | — | Every row ✅/❌ with a note; colleague run logged. |

## 4. Risks
- Slice 1 changes the look of every page at once (there was never a light
  theme); red-50/amber-50 boxes that looked fine on `#0a0a0a` will surface —
  hand-check all six loop pages in slice 1.
- `tailwind-merge` 2.6.1 → 3.x is a major bump under `cn()`; mis-merges are
  silent (sizes/rounding), not type errors.
- shadcn CLI style resolution (`new-york` → `new-york-v4` on Tailwind v4) is
  read from the CLI source, not executed — the `--dry-run` is the gate. Never
  re-run `shadcn init`. `add` does not pull cva/lucide/tw-animate-css.
- `next/font/google` downloads at build — the ECS Fargate image build (ADR
  0014) needs egress to fonts.googleapis.com or the TTFs must be vendored.
- `AssessmentEditor.tsx` is edited by slices 4, 5 and 9: keep them sequential;
  no second-terminal worktree on `client/` until slice 5 lands.
- Publish readiness is client-side; the server still accepts
  `status=published` with zero items (`lib/api/assessments.ts:36-65`) —
  separate proposal.
- Slice 7 rewrites the surface the peek/event hand-runs verified; those rows
  must be re-run with the real locked client (and 10.7 applies on Aurora).
- Skylight may read yellow on some monitors — one variable, but decide before
  badges are checked against it.

## 5. Gaps the proposal does not cover (recorded, not decided)
- Nothing "says secure out loud" (a Locked marker on published assessments /
  session cards; "Emergency exit" / "Lockdown failed" labels not rewritten).
- No search/filter on the Assessments list or the Students roster.
- `proxy.ts:24` "server misconfigured" stays text/plain.
- In-editor image upload (ImagePicker still sends the teacher to /uploads).
- Accommodations chip on monitor rows; print session information; per-student
  pin/sort on the monitor; HotspotEditor drag-only authoring (WCAG 2.5.7).
- Client "Your tests" row truncation and the "5 items delivers 6" seed nit —
  out of scope here (client / fixture).
- Dark theme: none in pass 1; teachers who liked the accidental dark lose it.

## 6. Questions

Answered 2026-08-30: **1.1 Mist `#F3F8FA`** ("most distinct from previous in-house apps"), **1.2 Cedar**, **1.3 OK**, **1.4 light-only** (dark mode wanted later as a feature), **1.5 Pacific band**, **2.1 approved**, **3.1 accepted**, **5.4 ten slices as listed**. Still open: 1.6, 2.2, 3.2–3.5, 4.1, 4.2, 5.1–5.3.

Original list (answer with the number):
- 1.1 Page ground: Skylight `#FFFAEC` (rec) or Mist `#F3F8FA`? Decide in Chrome after slice 1.
- 1.2 Primary button: Cedar (rec, 6.22:1) or Pacific (10.7:1)?
- 1.3 Fonts: Josefin Sans headings + Inter body OK? ECS build egress for next/font, or vendor TTFs?
- 1.4 Light-only for pass 1 (auto-dark dropped; `.dark` reserved) — OK?
- 1.5 Header: Pacific band (rec) or quieter Sea Foam band?
- 1.6 components.json: bump style to `new-york-v4` after the dry-run?
- 2.1 Nouns: Test session / Session code / Close session / Handed in / Needs attention / View screen / Students — approve? (UI labels only.)
- 2.2 Nav: Assessments · Students only + Open-now strip; Sessions page and first-run checklist deferred — OK?
- 3.1 Editor tabs via `?tab=` (no AssessmentEditor split) — accept?
- 3.2 A-07 hand-run first: does Add item show the new card without a reload on `main` today?
- 3.3 Scoring queue / Results: muted "More" row (rec) or hidden until Phase 3?
- 3.4 Placeholder questions: relax create-path `stem: min(1)` (`lib/api/items.ts:17`) for empty new items, or keep seeded text + "Incomplete" badge?
- 3.5 Publish readiness client-side now; server rule filed separately — OK?
- 4.1 ACC-01: create the overlay row on first visit via `findOrBindOverlay(createIfMissing=true)` (data change), or ship the `POST /api/students` fallback (SSID-only rows, `roster_ps_id` null)?
- 4.2 ACC-08: Value select from TIDE catalog client-side now; server validation later — OK?
- 5.1 Hand-run rows: new `docs/design-tool-manual-checks.md` (rec) or a section in `client/MANUAL-CHECKS.md`?
- 5.2 Fresh-eyes colleague for the exit-criterion row? Can it run before Sep 2 with demo students?
- 5.3 Seed nit "5 items delivers 6" — separate fixture fix, not UX?
- 5.4 Slice granularity: 10 as listed, or merge 5+6 / 8+9?

## Appendix — audit findings index (72; 2 blockers, 47 major, 23 minor)

Groups: SH = shell/dashboard, A = authoring, ACC = accommodations, SM = sessions/monitor.
Lines are as of `main` @ `f3d8464` (2026-08-30).

### SH

| id | sev | category | where | finding | proposal |
|---|---|---|---|---|---|
| SH-01 | blocker | navigation | `app/dashboard/page.tsx:33` | Sessions and Monitor are unreachable from the dashboard: the action row offers Uploads / Accommodations / Import JSON / New assessment / Sign out; the only path is row → editor → client-state 'Sittings' tab (AssessmentEditor.tsx:344, 751-784) → Monitor link (SittingsPanel.tsx:412-416); no open-session signal on rows. Also filed as SM-01 (adds: the monitor's '← Back to editor' at MonitorView.tsx:103 lands on the Edit tab). Verified. | Open-now strip + 'Open session · CODE' badge on rows (slice 3); ?tab= URL tabs and a breadcrumb back to ?tab=sessions (slices 4, 7). |
| SH-02 | major | information-architecture | `app/layout.tsx:16` | No app shell: RootLayout renders bare <body>{children}</body>; no header, brand, nav, favicon; per-page back links differ. Verified. | app/dashboard/layout.tsx with AppHeader (Pacific band, Assessments · Students, email + Sign out) and PageHeader/Breadcrumb (slice 2). |
| SH-03 | major | terminology-copy | `app/dashboard/page.tsx:70` | Identity line prints `session.sub` although session.email is on the payload (lib/auth/session.ts:14). Verified. | Render session.email ?? session.sub in the shell header (slice 2). |
| SH-04 | major | empty-loading-error | `proxy.ts:39` | Student-role session on /dashboard gets a text/plain 403 with no brand and no sign-out; the 500 'server misconfigured' at :24 is the same shape. Verified (:37-42). | Redirect to /login?error=student_account with a Sign-out primary (slice 2); the 500 branch remains a gap. |
| SH-05 | major | empty-loading-error | `app/login/page.tsx:26` | Only account_not_allowed is humanised; every other callback code renders 'Login error: <code>…</code>'. Verified. | errorCopy map for auth codes rendered in Alert destructive (slice 2). |
| SH-06 | major | empty-loading-error | `app/dashboard/page.tsx:22` | No loading.tsx, error.tsx or not-found.tsx anywhere under app/ while every dashboard page is force-dynamic. Also filed as ACC-12 ([studentId]/page.tsx:32 Forbidden dead end). Verified (find returns nothing). | Route boundaries + Skeleton; Forbidden branches → notFound() (slice 3). |
| SH-07 | major | navigation | `app/dashboard/new/page.tsx:51` | Create redirects to /dashboard, not into the new assessment; Import lands in the editor (import/page.tsx:52). Verified. | .returning({ id }) and redirect(`/dashboard/${id}`) (slice 3). |
| SH-08 | major | empty-loading-error | `app/dashboard/new/page.tsx:21` | Validation is a ?error= redirect round-trip with internal messages, no field association, typed values lost, no pending state. Verified. | useActionState returning { fieldErrors, values }; field-scoped copy (slice 3). |
| SH-09 | major | information-architecture | `app/dashboard/page.tsx:94` | Rows show the raw status enum and a server-locale date; no item count, no open-session state, no filter. Verified (:95-98). | Badges via label map, count(items), open-session badge, fixed-timezone date (slice 3); filter deferred (gap). |
| SH-10 | major | terminology-copy | `app/dashboard/import/page.tsx:65` | Developer prose in teacher copy: ItemBundleSchema/PoC-B/sha256/uuids; uploads/page.tsx:41-43 stale 'Slice 10 … ADR 0008'; 'Allow LLM-assisted item authoring'. Verified. | Teacher copy rewrite (slice 3), AI toggle moves to Settings (slice 4). |
| SH-11 | major | empty-loading-error | `app/dashboard/import/page.tsx:73` | Import errors render raw codes (no_file_selected, schema_invalid:…); no pending state on a 50 MB upload. | errorCopy + useFormStatus pending (slice 3). |
| SH-12 | minor | component-consistency | `app/dashboard/new/page.tsx:137` | Up-navigation phrased four ways ('Cancel', '← Back to dashboard', '← Dashboard', muted underline) mixing <a> and Link; 10 '← ' links in app/. | Breadcrumb in the shell; Cancel as Button variant=link; next/link everywhere (slice 2). |
| SH-13 | minor | information-architecture | `app/dashboard/page.tsx:58` | Sign out styled like Uploads/Accommodations in the primary action row; identity and Sign out exist on no other page. | Move to the shell header (slice 2). |
| SH-14 | minor | navigation | `app/page.tsx:1` | Root landing page has no session check; signed-in teachers see 'Sign in' again. | Redirect by session (slice 2). |
| SH-15 | minor | component-consistency | `app/login/page.tsx:32` | 'Sign in with Google' is a generic dark button without the G mark. Verified. | Button outline with the G SVG (slice 2). |
| SH-16 | minor | empty-loading-error | `app/dashboard/uploads/UploadsPanel.tsx:65` | Silent router.refresh() success, native confirm() delete with no busy state, raw 'upload: 413' errors, raw asset URL for Open. | AlertDialog + Alert (slice 3); lightbox/toast pass 2. |
| SH-17 | minor | color-visual | `app/globals.css:15` | Five grayscale tokens, no primary/accent/destructive/success token, raw Tailwind status hues in JSX, .math-error hard-codes #cc0000, system font; the nested dark @theme at :23-31 ships dark-only tokens. Also filed as A-17 and ACC-17 (same token set). Verified. | PSD token set + fonts + light-only (slice 1); .math-error retokenised (slice 9). |
| SH-18 | minor | component-consistency | `app/dashboard/page.tsx:11` | Unreachable 'No session' branches on dashboard (:11-20) and uploads (:12-21) — proxy.ts:18-20 already redirects. Verified. | redirect('/login?next=…') like sibling pages (slice 2). |
| SH-19 | minor | information-architecture | `app/layout.tsx:4` | Static title 'Secure-Test Design Tool' on every route, no favicon; 'Design Tool' is an internal name. Verified. | Title template + per-page metadata + app/icon.svg (slices 1-2). |

### A

| id | sev | category | where | finding | proposal |
|---|---|---|---|---|---|
| A-01 | major | navigation | `app/dashboard/[id]/AssessmentEditor.tsx:789` | Page has no identity: the name is an input under h1 'Assessment metadata', the fourth heading after h2 'Preview' and the tab strip; heading order inverted. Verified. | PageHeader with h1 = name, status Badge; Settings under h2 (slice 4). |
| A-02 | major | information-architecture | `app/dashboard/[id]/AssessmentEditor.tsx:690` | Preview section with a 420px iframe sits above the tab strip (754), so it renders on the Overrides and Sittings tabs and pushes editing below the fold; copy is developer-facing. Also filed as SM-02. Verified. | PreviewFrame collapsible inside Questions; tab strip under the header (slice 4). |
| A-03 | major | navigation | `app/dashboard/[id]/AssessmentEditor.tsx:754` | Tabs are local React state (comment at 751-753); reload/Back return to Edit; role=tab buttons without tabpanel or arrow keys. Verified. | shadcn Tabs bound to ?tab= (slice 4). |
| A-04 | major | information-architecture | `app/dashboard/[id]/AssessmentEditor.tsx:663` | Most prominent header actions are Scoring queue, Results (Phase 3 routes) and Export JSON; no Publish or Add question primary. Verified (:663-686). | Publish primary; Download backup + Phase 3 links in a muted More row (slice 4). |
| A-05 | major | empty-loading-error | `app/dashboard/[id]/AssessmentEditor.tsx:410` | call() throws `${res.status} ${text.slice(0,160)}` and every failure lands in one top banner; invalid_body detail is pretty-printed Zod JSON (stem min(1) at lib/api/items.ts:17). Verified. | errorCopy map; inline Alert in the failing card (slice 5). |
| A-06 | major | empty-loading-error | `app/dashboard/[id]/AssessmentEditor.tsx:1584` | No 'Saved' signal after Save item / Save metadata (silent refresh at 415-417, 444-447); no dirty state; no leave guard. Verified. | StatusLine, per-card dirty state, beforeunload (slices 4-5). |
| A-07 | major | empty-loading-error | `app/dashboard/[id]/AssessmentEditor.tsx:325` | VERIFY BY HAND-RUN: `items` is seeded once with useState(initialItems) and never resynced; addItem (504-512), deleteItem (567-576) and the import panels rely solely on router.refresh(), which preserves useState — on documented behaviour a new item would not appear until a full reload. Setup verified; outcome unverified. | Optimistic list updates with refresh as reconciliation (slice 5); hand-run first (open question 3.2). |
| A-08 | major | terminology-copy | `app/dashboard/[id]/AssessmentEditor.tsx:483` | Add item persists placeholder content as real content ('New question', 'Choice A'/'Choice B' with 'a' correct; 'answer'); new card appended with no scroll/focus. Verified. | Empty items + HTML placeholders + 'Incomplete' badge; focus the new card (slice 5; open question 3.4). |
| A-09 | major | information-architecture | `app/dashboard/[id]/AssessmentEditor.tsx:827` | Publishing is a bare Status <select> (draft/published) committed by Save metadata; no readiness check server-side (lib/api/assessments.ts:36-65); lock banner says 'below' on tabs without the select. Verified. | Publish/Unpublish Dialog with a client readiness checklist (slice 4); server rule as a separate proposal. |
| A-10 | blocker | navigation | `app/dashboard/[id]/AssessmentEditor.tsx:1609` | The done-authoring → start-a-session handoff is unsignposted: nothing says sessions need publishing, no control is named Publish, the Sittings tab's notice (SittingsPanel.tsx:282-287) links nowhere. Verified. | NextStepCard + Publish action inside the sessions notice (slice 4). |
| A-11 | major | component-consistency | `app/dashboard/[id]/AssessmentEditor.tsx:568` | Native confirm('Delete this item?') names nothing; other removals (rubric, hotspot image, choice) have no guard and are recoverable only by not saving, which is never explained. Verified. | AlertDialog naming the question; dirty state for local removals (slice 5). |
| A-12 | major | information-architecture | `app/dashboard/[id]/AssessmentEditor.tsx:941` | Four content-entry idioms (dashed add bar, AI toggle panel, CSV/PDF collapsibles, native <details>) plus Image…/Math… toggles under every field (10 on a 4-choice item). | Add question + outline buttons opening Dialogs (slice 5); DropdownMenu split button pass 2. |
| A-13 | major | terminology-copy | `app/dashboard/[id]/AssessmentEditor.tsx:1152` | Jargon in teacher copy: Stem, Assessment metadata, Per-student overrides, Provider: mock, construct-altering, T1-T4/OOB badges, docs/accommodations.md, Choice id, CSP-locked, type parentheticals. | Glossary applied across slices 4-5. |
| A-14 | major | layout-density | `app/dashboard/[id]/AssessmentEditor.tsx:837` | The full OSPI accommodations checklist shares one Save with name/time limit/status, Save below a long checklist. | Own Accommodations tab with its own Save (slice 4). |
| A-15 | minor | empty-loading-error | `app/dashboard/[id]/AssessmentEditor.tsx:1109` | 'No items yet.' has no CTA; loading is bare text in ImagePicker/PdfImportPanel/MathTranslator; the preview iframe has no loading/failure state; page.tsx Forbidden (34-43) has no way back. Verified. | EmptyState with Add question; PreviewFrame; Forbidden → notFound() (slices 3-5). |
| A-16 | major | accessibility | `app/dashboard/[id]/AssessmentEditor.tsx:1426` | Correct-answer radio/checkbox has no accessible name; editable Choice id exposed; '−' has title only; four disabled opacities. Verified. | aria-labels, letter label, icon Buttons, one disabled style (slices 5, 9). |
| A-18 | minor | terminology-copy | `app/dashboard/[id]/AssessmentEditor.tsx:1204` | Stale/forward copy: '(authoring only)' for drawing, 'used by Phase 3 scoring', 'With feedback (Phase 3)'. | Remove phase references (slices 4-5). |
| A-19 | minor | layout-density | `app/dashboard/[id]/AssessmentEditor.tsx:1114` | Every item card fully expanded in one column; ↑/↓ one-step reorder with a round-trip each. | Accordion list + drag reorder — pass 2 (recorded in slice 10). |
| A-20 | minor | empty-loading-error | `app/dashboard/[id]/AssessmentEditor.tsx:963` | AI generation availability is a create-time checkbox not editable in the editor (PATCH accepts allow_llm_authoring, saveMetadata omits it); when off nothing explains. | Settings toggle (slice 4). |

### ACC

| id | sev | category | where | finding | proposal |
|---|---|---|---|---|---|
| ACC-01 | major | information-architecture | `app/dashboard/accommodations/page.tsx:150` | Roster rows without an overlay row are inert divs; no UI creates the overlay (POST /api/students has no caller); a rostered student not in TIDE cannot receive a manual accommodation until they join a session. Verified (:150-159). | Lazy creation via findOrBindOverlay(createIfMissing=true) (slice 8; open question 4.1). |
| ACC-02 | major | information-architecture | `app/dashboard/accommodations/page.tsx:143` | 'N accommodations' counts every non-removed row incl. TIDE 'Off' (teacherRoster.ts:70; importer inserts all resolved rows, importTide.ts:383-394); enabled rows per isEnabledValue never shown. Verified. | 'N supports on' via isEnabledValue; Off rows collapsed (slice 8). |
| ACC-03 | major | information-architecture | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:243` | IEP/504 tier (catalog ospi_tier) never rendered; only a 10px provenance chip with the TIDE code in a title attribute. Verified. | Tier Badge per row; 'IEP/504: N' on roster rows (slice 8). |
| ACC-04 | major | navigation | `app/dashboard/accommodations/import/ImportTidePanel.tsx:178` | No way back to the assessment that sent the teacher to import; no breadcrumb/shell/return param; every tab titled the same. | Shell + Breadcrumb (slice 2); ?return= on the import link (slice 8). |
| ACC-05 | major | empty-loading-error | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:67` | API failures surface as `${status} ${text.slice(0,200)}` (also ImportTidePanel.tsx:31-33, DiffReviewPanel.tsx:42-44); terse lowercase validation copy. Verified. | errorCopy map + Alert (slice 8). |
| ACC-06 | major | terminology-copy | `app/dashboard/accommodations/import/ImportTidePanel.tsx:74` | Import result speaks importer internals ('touched', 'soft-removed', 'dropped', 'catalog drift', a repo path). | Outcome sentences in TIDE vocabulary (slice 8). |
| ACC-07 | major | navigation | `app/dashboard/accommodations/page.tsx:56` | Diff-review screen is linked only from the just-finished import's result card; the roster never shows pending reviews. | pendingDiffs.ts + roster Alert + per-row Review badge (slice 8). |
| ACC-08 | major | component-consistency | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:196` | Value is free text (server accepts any 1-200 chars, lib/api/students.ts:33,40) though TIDE enumerates legal values; delivery treats anything outside {'',off,none,none (default),default} as ON (effective.ts:79-83), so 'No' enables the tool. Verified. | NativeSelect from TIDE catalog values client-side (slice 8); server validation separate. |
| ACC-09 | major | terminology-copy | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:164` | Manual add forces a TIDE subject with no help text although delivery unions across subjects (effective.ts:100-104). | Subject 'ANY' — deferred (schema change), recorded in slice 10. |
| ACC-10 | minor | terminology-copy | `app/dashboard/accommodations/import/review/DiffReviewPanel.tsx:80` | Diff rows show SSID · subject · raw tool_id with 'kept value'/'TIDE says'/'Accept TIDE'. | Student name + catalog label; 'Your value / TIDE value'; 'Use TIDE value' + 'Keep mine' (slice 8). |
| ACC-11 | minor | terminology-copy | `lib/accommodations/catalog.ts:63` | Tool labels diverge from TIDE Tool Names and carry implementation parentheticals; the Tool select is a flat 55-entry list. | Grouped select by tier (slice 8); label alignment pass 2. |
| ACC-13 | minor | component-consistency | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:119` | Native confirm() for delete; TIDE rows show no remove control and no explanation. Verified. | AlertDialog; disabled Remove with helper text on TIDE rows (slice 8). |
| ACC-14 | minor | component-consistency | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:258` | Five button treatments and mixed casing ('Add manual' vs 'edit/save/delete'); no success feedback. | shadcn Button variants, sentence case, StatusLine (slices 8-9). |
| ACC-15 | minor | layout-density | `app/dashboard/accommodations/[studentId]/StudentEditor.tsx:161` | Add form above the student's settings list; values rendered as 'value: <code>On</code>'. | List first as a Table; Add support in a Dialog; value Badges (slice 8). |
| ACC-16 | minor | accessibility | `app/dashboard/accommodations/import/ImportTidePanel.tsx:48` | File input has no label; inline edit input unlabelled; TIDE code only in title; row buttons named 'edit'/'delete' without context. Verified (:48-53). | Labels and aria-labels (slice 8). |
| ACC-18 | minor | empty-loading-error | `app/dashboard/accommodations/[studentId]/page.tsx:60` | Heading is name \|\| ssid and the meta line always prints SSID, so a join-created row (nullable ssid, empty name) renders an empty h1; the roster handles it differently. | Shared format.studentHeading (slice 8). |

### SM

| id | sev | category | where | finding | proposal |
|---|---|---|---|---|---|
| SM-03 | major | information-architecture | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:110` | The 48px code shares the page with every named student's status and Peek buttons, so projecting it exposes per-student data; no copy-to-clipboard. (Legibility arithmetic unverified.) Verified. | ShowCodeDialog projector view + SessionCode with Copy (slices 6-7). |
| SM-04 | major | empty-loading-error | `app/dashboard/[id]/SittingsPanel.tsx:288` | A failed initial load (catch at :105-108 sets error, loading false, sections=[]) renders the normal form plus 'No sections on your roster' and 'No sittings yet'. Verified. | Explicit loading \| error \| ready state; Alert with Retry (slice 6). |
| SM-05 | major | empty-loading-error | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:51` | open is false while data is null, polling returns early on !open (:54), Refresh and the header are inside the data branch (:108, :130) — one failed first fetch leaves a dead page. Verified. | Server-passed header, polling regardless of last result, Retry outside the data branch, skeletons (slice 7). |
| SM-06 | major | empty-loading-error | `app/dashboard/[id]/SittingsPanel.tsx:235` | loadAttendance and the 5 s poll (:151) clear the shared error string, so a create/close failure vanishes; MonitorView does the same on success (:41). Verified. | Separate action and live-fetch error channels (slices 6-7). |
| SM-07 | major | terminology-copy | `app/dashboard/[id]/SittingsPanel.tsx:210` | Server codes reach the teacher verbatim (invalid_body, not_published, section_not_taught…) plus 'sittings load failed (500)' strings. | errorCopy map; client-side minutes validation (slice 6). |
| SM-08 | major | terminology-copy | `app/dashboard/[id]/SittingsPanel.tsx:281` | 'Sitting' vs API test_sessions vs client 'Your tests'; lowercase open/closed/expired pills beside capitalised status words. Verified (:404). | Test session / Session code / Open / Closed / Ended (slice 6). |
| SM-09 | major | component-consistency | `app/dashboard/[id]/SittingsPanel.tsx:421` | Closing a session is one unguarded click on both surfaces (MonitorView.tsx:120), irreversible, effect unstated; OverridesPanel uses confirm() for a smaller action. Verified. | Shared AlertDialog stating that students already in can finish (slices 6-7). |
| SM-10 | major | terminology-copy | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:207` | Sticky alerts (sittingAttendance.ts:126-142) look identical to a current problem while the student is visibly working; no legend. Verified. | Current-vs-earlier presentation rule + legend (slice 7). |
| SM-11 | major | layout-density | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:156` | No triage: alphabetical 3-up card grid, counts only joined/submitted, no filter. Verified. | MonitorSummary tiles as filters; grouped Table rows (slice 7). |
| SM-12 | major | color-visual | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:203` | Raw Tailwind status hues with no tokens; pills compute 4.32 (amber) / 4.24 (green) in light and 2.78-3.37 under the shipped dark tokens. Verified (:203, :208). | Status tokens + StatusBadge (slices 1, 6-7). |
| SM-13 | major | accessibility | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:344` | Peek modal has role=dialog but no aria-modal, focus trap, Escape or focus return; state changes are silent to AT. Verified. | shadcn Dialog + aria-live (slice 7). |
| SM-14 | major | other | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:356` | Modal timestamp is `new Date().toLocaleTimeString()` at render, advancing every 5 s while open. Verified. | Record Date.now() when collect returns 'ready' (slice 7). |
| SM-15 | major | terminology-copy | `app/dashboard/[id]/OverridesPanel.tsx:160` | Empty-state CTA names an 'Accommodations tab' that does not exist; 'roster' means PowerSchool sections on one tab and the TIDE overlay on the other. Verified. | Link to ?tab=accommodations; name the two sources (slice 8). |
| SM-16 | major | empty-loading-error | `app/dashboard/[id]/SittingsPanel.tsx:371` | With zero sections Create stays enabled (disabled only on busy/!isPublished) and 'roster sync' names no action. Verified. | Disable Start; PowerSchool 6 AM copy (slice 6). |
| SM-17 | minor | terminology-copy | `app/dashboard/[id]/attendanceView.ts:48` | All times use toLocaleString() with seconds and full date; 'until' vs 'open until'. Verified. | format.ts today-aware formatter (slices 6-7). |
| SM-18 | minor | component-consistency | `app/dashboard/[id]/SittingsPanel.tsx:449` | Two live surfaces with separate polling and duplicated pills/progress bars. | Shared StatusBadge/ProgressBar/LiveIndicator (slices 6-7); single live surface pass 2. |
| SM-19 | minor | empty-loading-error | `app/dashboard/[id]/SittingsPanel.tsx:266` | Loading is bare text in five places with no layout reservation. | Skeleton rows (slices 6-7). |
| SM-20 | minor | terminology-copy | `app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx:340` | 'Peek' is the internal name; the student-notice line follows the image; outcomes are a disabled label plus grey note. Verified. | 'View screen' with helper before the click and state Badges (slice 7). |

## 7. Slice log

- **Slice 1 — foundation — BUILT 2026-08-30, awaiting James's Chrome check, not committed.**
  `bun add radix-ui class-variance-authority lucide-react tailwind-merge@^3`,
  `bun add -d tw-animate-css`; `bunx --bun shadcn@latest add` (16 items; the
  registry now serves `bases/radix` sources importing the unified `radix-ui`
  package — the `new-york-v4` path check in slice 1(b) is moot, `components.json`
  left as is); `app/globals.css` rewritten to `:root` tokens + `@theme inline`
  (Mist ground; KaTeX import kept; nested `@media { @theme }` deleted; legacy
  `--color-*` names still emitted — verified in the compiled chunk: `--background:
  #f3f8fa`, `--color-border: var(--border)`, no `#0a0a0a`); `app/fonts.ts` +
  `app/layout.tsx` (Inter + Josefin Sans via `next/font/google`, title template
  `%s · Secure-Test`); `h1 { font-family: var(--font-heading) }` in `@layer base`
  (h1 only — two existing h2s are 16 px, below the 20 px floor); Badge variants
  `success | warning | danger | info | neutral`, Alert variant `warning`, Skeleton
  on `bg-muted`. Deviation from 1(e): the shadcn default focus treatment
  (`focus-visible:border-ring` + 3 px `ring-ring/50`) is kept instead of a custom
  2 px/offset rule — one fewer override. No screen JSX changed, so existing
  "primary" buttons render Pacific-on-Mist until slice 3+ swaps them to Cedar.
  Evidence: `bun run typecheck` clean; `DATABASE_URL=…_test bun test` 903 pass /
  0 fail; `/login` 200 from the running dev server with no build errors.
- **Slice 2 — app shell, identity, sign-in surfaces, titles — BUILT 2026-08-30,
  awaiting James's Chrome check, not committed.** `app/dashboard/layout.tsx`
  renders `components/app/AppHeader.tsx` on every dashboard route (Pacific
  band, white PSD emblem + "Secure-Test" in Josefin Sans, nav Assessments ·
  Students with the Sea Glass active underline, `session.email ?? session.sub`,
  Sign out); `components/app/PageHeader.tsx` (`Crumbs` + `PageHeader`) used by
  new / import / uploads / Students / student / TIDE import / review, and
  `Crumbs` alone inside the editor and monitor headers (their h1s are reworked
  in slices 4 and 7, so "last crumb = h1" does not hold there yet); the 10
  `← ` links are gone from the loop (the two in scoring/results — out of scope —
  stay); `lib/ui/errorCopy.ts` maps every code `app/api/auth/callback/route.ts`
  can emit plus Google's `access_denied` and the new `student_account`;
  `app/login/page.tsx` is a Card with the two-colour emblem, an Alert for the
  mapped sentence (raw code shown only when the fix is IT's), an outline
  Sign-in-with-Google Button with the G mark, and — for `student_account` — a
  Sign out button instead; `proxy.ts` redirects a student-role session to
  `/login?error=student_account` instead of the text/plain 403; `app/page.tsx`
  redirects to /dashboard or /login; the unreachable "No session" branches on
  the dashboard and uploads pages became `redirect('/login?next=…')`; the
  dashboard h1 is "Assessments" (nav noun = h1) and its identity line + Sign
  out moved into the header; per-page `<title>`s (`generateMetadata` on the
  editor names the assessment, owner-only); `app/icon.png` (256 px two-colour
  emblem) and `public/brand/` emblems. Evidence: typecheck clean; 903 tests
  pass; `/` → 307 `/login`; `/login?error=student_account` renders the
  sentence + Sign out; `grep -rn '← ' app` = 0 outside scoring/results;
  /dashboard in Chrome shows the band with the signed-in staff account, tab
  "Assessments · Secure-Test".
- **Slice 3 — Assessments home — BUILT + COMMITTED 2026-08-30.** Home is a
  `PageHeader` with Images / Import assessment file / New assessment; an
  "Open now" strip (owner's `test_sessions` with `status = open` and
  `expires_at > now`, joined to the assessment) with `SessionCode` + Copy,
  "Closes at HH:MM" (`lib/ui/format.ts`, Pacific, today-aware) and a Monitor
  button — the first path from home to a session or the monitor (SH-01);
  rows are a Table with `AssessmentStatusBadge` (Draft/Published), an
  "Open session · CODE" info badge, `count(items)` questions and a date
  without a time; `EmptyState` (over shadcn `empty`) with New assessment.
  `new/`: `useActionState` form (`actions.ts` + `state.ts` + `NewAssessmentForm`)
  returns `{ fieldErrors, values }` under the field with the typed values kept,
  and success lands inside the new assessment (SH-07); the AI checkbox left the
  create form (slice 4 puts it in Settings). Import: teacher copy, `importErrorCopy`,
  pending button. Uploads → "Images": teacher copy, `UploadsPanel` on Button/
  Input/Alert with an AlertDialog for delete (one `confirm()` fewer) and
  `uploadErrorCopy` for the route's JSON codes. Route boundaries:
  `app/dashboard/loading.tsx` (skeleton), `app/dashboard/error.tsx`
  (Try again via `reset()`), `app/not-found.tsx`; the editor's Forbidden
  branch is `notFound()`. Shared: `StatusBadge` (assessment / session / student
  vocabularies), `SessionCode`, `SubmitButton`, `format.ts`. Gotcha logged:
  a `"use server"` module may export only async functions — the form state
  lives in `state.ts`; the first render of `/dashboard/new` hit `error.tsx`,
  which incidentally verified that boundary. Evidence: typecheck clean; 903
  tests pass; in Chrome the table, badges and counts render; creating "UX
  pass 1 slice 3 check" landed at `/dashboard/<uuid>` with the name in the
  breadcrumb and tab; `/dashboard/import?error=schema_invalid:…` shows the
  sentence with the code beneath; `/dashboard/nope` shows the not-found page.
- **Slice 4 — editor structure — BUILT + COMMITTED 2026-08-30.** The editor
  opens with a `PageHeader` (Assessments › name; h1 = name; Draft/Published
  badge; description; Preview / Print / **Publish** or **Unpublish**) and a
  muted row for Download backup (.json) · Scoring queue · Results (demoted,
  not removed — 3.3). shadcn Tabs bound to `?tab=questions|settings|
  accommodations|students|sessions` via `router.replace` (labels Questions /
  Settings / Accommodations / Student accommodations / Test sessions; reload,
  Back and deep links restore the tab — 3.1). `PublishDialog` shows a readiness
  checklist from `app/dashboard/[id]/readiness.ts` (`questionGaps` /
  `readinessChecks`, 7 unit tests) and PATCHes `{ status }` only — the one
  change `requireDraft` accepts on a published row; Unpublish is the same
  dialog in reverse. The status `<select>` + "Save metadata" are gone (A-09).
  Settings tab: name, description, time limit, "Allow AI help when writing
  questions" (now sent as `allow_llm_authoring`), Save settings + `StatusLine`
  (`role=status`: Saving… → Saved HH:MM). Accommodations tab: the OSPI
  checklist with its own Save; the T1–OOB tier badges and the
  `docs/accommodations.md` pointer are gone; "construct-altering" reads
  "Changes what is measured". Questions tab: "Questions (n)", a collapsible
  `PreviewFrame` card (skeleton until the iframe paints; keyed on persisted
  state per cleanup #7) opened by the header's Preview button, and a
  `NextStepCard` at the end — draft: "Publish to lock the questions, then start
  a test session" → dialog; published: "Start a test session" → Test sessions
  tab (A-10). The lock banner is an Alert (warning) that no longer says
  "below". `SittingsPanel` takes `onPublish` and renders its draft notice as an
  Alert with a Publish button. Evidence: typecheck clean; 910 tests pass; in
  Chrome the draft shows Publish + the next-step card, `?tab=sessions` lands on
  Test sessions with the Publish notice, the published seed shows Unpublish +
  the lock Alert with Settings disabled, and the Publish dialog lists "No
  questions yet" for an empty draft.
- **Slice 5 — editor feedback — BUILT + COMMITTED 2026-08-30.** The item list
  is client-authoritative: Add question appends the POST's row (`rowToView`
  mirrors page.tsx), scrolls to it and focuses the question; Save question
  PATCHes and records the sent snapshot; Delete removes on 204; reorder rolls
  back on failure — no `router.refresh()` on item ops (A-07: the list was
  seeded once from props, so a refresh never showed a new card; the hand-run
  on `main` produced no card on two clicks and was inconclusive — moot now).
  Per card: "Incomplete" badge from `questionGaps` (which now also flags the
  seeded placeholder text — "New question", "Choice A", "answer" … — so a
  seeded question cannot read as ready, A-08, without relaxing the API's
  `stem: min(1)` — 3.4 stays open), "Unsaved changes" badge against the last
  persisted snapshot, Save enabled only when dirty, `StatusLine` beside it,
  inline Alert for that card's error (`ApiError` carries the route's JSON code;
  `itemErrorCopy` maps invalid_body / assessment_published_editing_locked /
  has_responses / type_change_not_supported / network), `beforeunload` while
  anything is dirty. Delete → AlertDialog "Delete question 3 — "…"?" (the
  editor's `confirm()` is gone); reorder/delete are icon Buttons (`size-8`,
  named "Move question n up/down", "Delete question n", delete set apart);
  the editable choice-id field is a static letter; radios read "Mark choice A
  as correct"; remove-choice is a named icon button. Copy: "Add a question" +
  NativeSelect + "Add question"; plain type nouns; "Question" not "Stem";
  "Generate a question with AI" / "Add this question"; no "Provider:"; no
  "(authoring only)" / "Phase 3". `EmptyState` for zero questions. Evidence:
  typecheck clean; 911 tests pass (8 readiness); in Chrome Add question →
  card appears at once with the cursor in it and "Incomplete"; editing shows
  "Unsaved changes"; Save question → "Saved 8:34 PM" and the button disables;
  Delete opens the named dialog (Escape cancels).
- **Slice 6 — Test sessions panel — BUILT + COMMITTED 2026-08-30.**
  `SittingsPanel` rewritten on the primitives: "Start a test session" Card
  with "Who is it for?" radios (logic unchanged) and "How long?" presets (This
  period · 55 min / 90 min / Rest of day → 4 PM Pacific) plus a 1–720 number
  input and a live "Opens now · Closes at HH:MM" line; Start disabled until
  the assessment is published, a section exists and the minutes are valid; a
  zero-section teacher sees the PowerSchool-6 AM Alert (SM-16). Load state is
  explicit — skeleton → error Alert with Retry → ready — so a failed fetch
  never reads as "No sections on your roster" (SM-04); action failures live in
  the card (`sessionErrorCopy`) and live-poll failures in `LiveIndicator`
  beside the stale table (SM-06). Rows are Cards: `SessionCode` (2xl mono) +
  Copy, `SessionStatusBadge` Open / Closed / Ended (time up), scope,
  "Closes at" or "Started …" (`format.ts`), Show code → `ShowCodeDialog`
  (Pacific full-screen: name, code at ~20vh, join line — SM-03), Monitor,
  Attendance, Close session → AlertDialog "Close session CODE? Nobody new can
  join. Students already in can finish and hand in…" (SM-09). Attendance is
  a shadcn Table with `StudentStatusBadge` (from the shared `studentState()`
  in `attendanceView.ts` — current-vs-earlier alert rule, 5 tests) and
  `ProgressBar`; "submitted" reads "handed in". EmptyState for no sessions.
  New: `ShowCodeDialog`, `LiveIndicator`, `ProgressBar`, `sessionErrorCopy`.
  Evidence: typecheck clean; 916 tests pass; in Chrome on the published seed:
  "This period · 55 min" shows "Closes at 9:32 PM" before Start; Start
  session created `25G9AX` (Open · All my sections · Closes at 9:33 PM) with
  Show code / Monitor / Attendance / Close session; older rows read Closed /
  Ended (time up) with "Started Aug 29, 8:03 PM"; Show code fills the screen;
  Close session opens the dialog (cancelled — the session stays open for
  slice 7's monitor check).
- **Slice 7 — Monitor + View screen — BUILT + COMMITTED 2026-08-30.** The
  monitor page passes `code` / `status` / `expires_at` from the server row so
  `MonitorView` paints its `PageHeader` (Assessments › name › Monitor CODE;
  Open/Closed/Ended badge; "closes at"; Show code / Refresh / Close session)
  and the code hero before the first fetch (SM-05); polling depends on the
  session being open, not on a fetch having succeeded, and a failed poll keeps
  the rows and reports through `LiveIndicator` ("Last update failed at HH:MM —
  retrying every 5 s · Retry now") (SM-06/13). `MonitorSummary`: five tiles
  (Needs attention · Idle · In progress · Not joined · Handed in) that filter
  the table, with a Sort A–Z toggle (SM-10). The 3-up card grid is a grouped
  Table: name + section, `ProgressBar`, `StudentStatusBadge` + the current
  alert as a factual line or an "Earlier: …" outline chip once demoted (the
  shared `studentState()` rule; the row carries a Clay left edge only while
  current — SM-11), last activity, and **View screen** (renamed from Peek;
  one helper sentence above the table before any click; states Requested… /
  No answer + Try again; disabled with a reason unless in progress). The frame
  opens in `ViewScreenDialog` (shadcn Dialog: focus trap, Esc, focus return)
  titled with the capture time taken when the frame ARRIVED, not at render
  (SM-20); the delete-on-read / discard-on-close lifecycle and the 2.5 s / 40 s
  collect poll are unchanged. Lobby `EmptyState` names the scope and the code
  with a Show code button; an sr-only `aria-live` line announces the
  needs-attention count (WCAG 4.1.3). Evidence: typecheck clean; 916 tests
  pass; in Chrome the dashboard's Open-now strip → Monitor lands on `25G9AX`
  with the header, code, "0 of 5 joined", live line and five rostered rows
  (Not joined); the Not joined tile filters ("Showing 5 of 5"); Close session
  opens the dialog (cancelled). The View screen and quit-and-rejoin rows need
  the real locked client (client/MANUAL-CHECKS.md, 8.5 + peek rows) — logged
  in slice 10's hand-run list.
- **Slice 8 — Students (accommodations) — BUILT + COMMITTED 2026-08-30.**
  "Students" everywhere (nav, h1, breadcrumbs, titles). The roster is a Table
  per section; every rostered student is a link — one with no record yet goes
  through the new `/dashboard/accommodations/roster/[psId]` route, which binds
  or creates the overlay row with the same `findOrBindOverlay` a first join
  uses (now exported) and redirects (ACC-01; **open question 4.1 taken as the
  proposal's primary path — this is the one data change in the pass; the
  hand-run created "Demo Student <demo-student-B>" in the dev DB**). Counts are honest:
  `loadOverlay` now aggregates in JS with `isEnabledValue` and the catalog's
  OSPI tier → "N supports on" (success/neutral), "IEP/504: N" (info), "N TIDE
  settings off" muted (ACC-02/03); a pending-review Alert + per-row "Review n"
  badge from the lifted `lib/accommodations/pendingDiffs.ts` (ACC-13). Student
  page: `studentHeading` (name → SSID → student number), list-first Table per
  subject (Tool · Setting badge · Kind: IEP/504 / Designated / Universal ·
  Source: TIDE / TIDE, edited by you / Added by you), On rows first with Off
  rows behind "Show N settings that are off"; **Add support** Dialog with
  Subject / Tool (grouped by tier) / Setting as a select of TIDE's own values
  for the pair (`tideValuesFor`, On/Off fallback — ACC-08 client half: typing
  "No" can no longer switch a tool ON); Edit inline with the same select;
  Remove → AlertDialog; TIDE rows explain why Remove is disabled;
  `accommodationErrorCopy`. Import: "Import TIDE settings", Label "TIDE
  Student Settings export (.xlsx)", `tideImportErrorCopy`, results in TIDE
  words (settings taken from TIDE / you had changed were kept / TIDE no longer
  lists were turned off / rows skipped), drift copy without the repo path,
  "N changes to review" → Review, `?return=` back link. Review: student name +
  tool label, "Your value" / "TIDE value", **Use TIDE value** / **Keep mine**
  (local dismiss). Student accommodations tab (`OverridesPanel`): explicit
  load state, students listed by name, Setting as a select
  (`tideValuesForTool`), the empty-state CTA opens the Accommodations tab that
  exists (SM-15), the two sources named, Remove → AlertDialog, import link
  carries `?return=`. Evidence: typecheck clean; 916 tests pass; in Chrome the
  Students table shows "3 supports on · IEP/504: 2" for Ben; his page lists
  three rows with kind and source; Add support opens with the three selects;
  `/roster/<demo-student-B>` created and opened "Demo Student <demo-student-B>"; the import page
  and the Student accommodations tab render on the primitives. Not hand-run:
  a real TIDE xlsx import and review (needs the sample file — slice 10 row).
- **Slice 9 — sweep — BUILT + COMMITTED 2026-08-30.** Mechanical codemod over
  every `app/**/*.tsx` (scoring/results included — a class rename with
  identical resolution, so those out-of-scope pages keep working):
  `[var(--color-*)]` arbitrary values → `bg-background` / `text-foreground` /
  `border-border` / `bg-muted` / `text-muted-foreground` / `hover:bg-accent` /
  `bg-primary text-primary-foreground`; every `dark:` utility deleted (the
  `.dark` variant stays declared, nothing adds the class); raw Tailwind hues →
  status tokens (`bg-danger text-danger-foreground`, `text-destructive`,
  `bg-warning …`, `text-success-foreground`, `…info-foreground` for the hotspot
  region outlines). `.math-error` on `--danger`; native checkbox/radio take
  `accent-color: var(--primary)`; RubricEditor's `window.confirm()` on a style
  switch is an AlertDialog ("Switch and discard" / "Keep the current style");
  ImagePicker's bare "Loading…" is a Skeleton. Sub-editor internals stay
  hand-rolled by design (proposal §2.4 "Untouched in pass 1") but now on the
  tokens. Nothing in `globals.css` needed dropping: the five names are shadcn's
  own theme tokens, not legacy. Evidence: `grep -rn 'var(--color-\|dark:\|
  focus:ring-1\|rounded-full\|confirm(' app` = 0; raw red/amber/green/blue hue
  classes = 0; typecheck clean; 916 tests pass; the editor's Questions tab
  looks as it did after slice 5 in Chrome.
- **Slice 10 — hand-run rows, glossary, pass-2 ledger — BUILT + COMMITTED
  2026-08-30 (docs only).** `docs/design-tool-manual-checks.md` (20 rows:
  dark-appearance render, Google cancel, student-account page, find-Start-in-5 s,
  validation, Add/Save question, Publish checklist, Start with a preset, Show
  code at 3 m mirrored, quit-and-rejoin demotion + tile filter (client), find
  needs-attention in 5 s, dev-server stop/restart, View screen (client), Close
  session, roster bind + Add support, TIDE import + review, bad upload, 13"
  walk, the exit-criterion run by a fresh-eyes colleague, ECS font egress);
  `docs/ux-pass-1.md` (decisions, token table with ratios, the teacher-word ↔
  identifier glossary, shell/states, WCAG 2.2 AA target + the hotspot 2.5.7
  gap, the pass-2 list); `docs/phase-7-slices.md` UX pass 1 entry and the
  `CLAUDE.md` status line updated. Not done by this session: the hand-run rows
  themselves (they are James's), and no `cdk deploy` / push.
