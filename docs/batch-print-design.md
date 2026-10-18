# Batch print — several sections and/or chosen students in one packet (U-9)

Design note, 2026-10-15. Roadmap row U-9 (`docs/roadmap-2026-09.md`, James
2026-09-23, "not mission critical"). Builds on Print student work
(`docs/student-work-export-design.md`, D-1 anonymous labels + key page,
D-2 every item type). Nothing is built.

## Decisions (James, 2026-10-15)

- **D-1** (2.1) One packet for several sections.
- **D-2** (2.2) Anonymous labels stay **numbered per section**, as today —
  with a key page **per section**. Consequence: each section's run ends
  with its own key page (so each section's stack tears off on its own),
  and every page footer carries the section, since "Student 01" repeats
  once per section in one stack.
- **D-3** (2.3) In-progress work off by default, a checkbox includes it
  with today's in-progress mark.
- **D-4** (2.4) Order: section as listed, then last / first name.
- **D-5** (2.5) Student checkboxes in the first version.
- **D-6** (8.1, 2026-10-18) A chosen student prints whatever their status —
  `in_progress` governs only a section's run, as the single-student print
  always did.
- **D-7** (8.2) "As listed" means alphabetical, the toolbar's order, not URL
  order; chosen students with no section print last.
- **D-8** (8.3) The flag is `in_progress=1`.

## What exists

- `/dashboard/[id]/results/work` (`app/dashboard/[id]/results/work/page.tsx`,
  parser `lib/reporting/workPacket.ts:80–116`). Options are URL parameters
  so a packet is a bookmarkable link; the toolbar is a no-JS
  `<form method="GET">`.
- **One section per URL**: `section` is a last-value-wins scalar (a test
  asserts `?section=a&section=b` means `b`). Handed-in attempts only,
  ordered last name → first name; anonymous labels `Student NN` numbered
  **per section** over the section's handed-in attempts; one key page last.
- **One student**: `?attempt=<uuid>` (in-progress included and marked on the
  paper "In progress — not handed in · answers saved so far").
- **No section given**: a chooser listing each section with handed-in work
  and a count — "One URL per section is the contract, so rather than
  printing 'all sections' this lists what there is to print" (`page.tsx`
  ~:383).
- `items` is the only multi-value parameter today (`allValues`).
- FERPA rule (`page.tsx:59–60`, doc §FERPA): no student identifier in the
  URL beyond the section label; `?attempt=` already uses an opaque id.

## Design

**Selection, still a GET URL:**
- `section` becomes multi-value (`section=P1&section=P3`), parsed with
  `allValues`. One value behaves exactly as today.
- `attempt` becomes multi-value too. With sections given, the attempts
  must belong to them (others ignored); with no section, the attempts alone
  define the packet.
- Size check: ~45 bytes per attempt id; a 150-student, all-sections batch
  is ~7 KB plus `items` — under the ALB's and Node's 16 KB limits. Above
  a cap (say 200 attempt ids) the toolbar says "Choose sections instead of
  students" rather than building a URL that may fail.

**Toolbar (no JS, two steps like today's form):**
- Sections become checkboxes (each with its handed-in count).
- Under "Students", checkboxes for every student in the ticked sections,
  grouped by section; none ticked = everyone in those sections. The list
  appears after the form is submitted with sections (the GET round trip
  the toolbar already uses).
- "Include work not yet handed in" checkbox, off by default; when on,
  in-progress attempts print with today's in-progress mark.
- The chooser screen gains "Print selected" instead of only one link per
  section.

**The packet:**
- One document. Order: section (as listed), then last name / first name —
  the same `packetOrdering` within each section.
- A section divider line on the first page of each section's run (screen
  and print), so a stack can be split by hand.
- Anonymous labels: **numbered per section** (D-2, as today), and a key
  page at the end of each section's run listing label → name, number for
  that section. The page footer names the section beside the label.
- "N of M handed in" becomes one line per section on the screen strip.

**Unchanged:** scores / AI rows, `answers=0`, `questions`, spacing, `items`,
access (`view`; see `docs/coteacher-gaps-2026-10-design.md` G-3), the
single-student path (one `attempt` value, no section) prints exactly as
today, including its "In progress n" label.

## Slices

1. **Parser + packet** — multi `section` / `attempt`, the include-in-progress
   flag, packet ordering + dividers, per-section labels + a key page per
   section, the section in the footer;
   `test/work-packet.test.ts` (replace the last-wins `section` test) and
   `test/work-packet-page.test.tsx`. S.
2. **Toolbar + chooser** — section and student checkboxes, the cap
   message, "Print selected" on the chooser. S.
3. **Rows + help** — hand-run rows in `docs/design-tool-manual-checks.md`;
   help topic "Print student work" and its picture. XS.

Design tool only; no migration; no client release.

## Progress

- **Slice 1 BUILT 2026-10-18, not committed, not deployed.**
  `PacketQuery.sections` / `attempts` (multi-value, trimmed / uuid-checked,
  repeats dropped) and `inProgress`; `selectPacket` (`lib/reporting/
  workPacket.ts`) decides chooser / not found / one student / a batch of
  section runs by the rules above (a foreign attempt id is not found;
  chosen students outside the ticked sections are ignored, and with none
  left the sections print in full); `sectionAnonymousLabels` numbers per
  section over its handed-in work, "In progress n" otherwise;
  `stripLine` / `keyCountLine`. The page renders one run per section —
  divider on its first page and the section in every footer only when
  there is more than one run, a key page closing each run, one strip line
  per run. The toolbar and chooser are unchanged (slice 2): the section
  select shows the first run's section. A one-section URL, a one-attempt
  URL and every bookmarked link print as before (the 48 existing page tests
  pass unchanged). Tests: `test/work-packet.test.ts` (the last-wins
  `section` test replaced; `selectPacket`, labels, lines) and six batch
  cases in `test/work-packet-page.test.tsx`.

## Open questions — answered 2026-10-15 (see Decisions)

- 2.1 One packet for several sections (recommended), or one packet per
  section (several print dialogs)?
- 2.2 Anonymous labels numbered across the whole packet with one key page
  (recommended), or per section with a key page per section?
- 2.3 In-progress work: off by default with a checkbox (recommended), or
  never in a batch (single-student only, as today)?
- 2.4 Order: section then name (recommended), or name across sections?
- 2.5 Student checkboxes in the first version, or sections only first?
