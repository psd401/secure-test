# Standards catalog sources

The catalog (`../catalog.json`) and crosswalk (`../crosswalk.json`) are built
by `design-tool/scripts/build-standards.ts` (`bun run standards:build`, run
from `design-tool/`) from the two workbooks and the NGSS intermediate JSON in
this folder. The script verifies each file's sha256 before reading it and
fails on a mismatch.

| File | URL | OSPI version label | Downloaded | sha256 |
| --- | --- | --- | --- | --- |
| `math26-final-adoption-spreadsheet.xlsx` | https://ospi.k12.wa.us/sites/default/files/2026-08/math26-final-adoption-spreadsheet.xlsx | August 2026 \| v3.1 | 2026-10-02 | `d522101f430758dcbc21d7ecc800977761b3ccdb224de2b3e6fd6217faa80875` |
| `ela26-final-adoption-spreadsheet.xlsx` | https://ospi.k12.wa.us/sites/default/files/2026-08/ela26-final-adoption-spreadsheet.xlsx | August 2026 \| v3.0 | 2026-10-02 | `d4a8f63b00d2359ac30185b7585181d9336997d1b0b749c0873007f19b7a3ced` |
| `AllDCI.pdf` (NGSS, **not committed** — 9.97 MB; extract with `bun run standards:extract-ngss <pdf>`) | https://www.nextgenscience.org/sites/default/files/AllDCI.pdf | "All Disciplinary Core Ideas" (103 pages) | 2026-10-02 | `79e26e426859caa31a235331920b58d57d0d49bd1cfe72c3683088c1eb4e5e05` |
| `ngss-performance-expectations.json` (committed, written by the extract script) | derived from `AllDCI.pdf` | 208 performance expectations | 2026-10-02 | `4d01ee0dd655a7eda84ed02e48fd153df8095eb47f04dfda8869b5e97c3f8c7a` |

## What each file contains

- **Math workbook** — sheets read by the build: "K-8 and Connections"
  (Washington 2026 K-8 standards, with the New in 2026 and Priority flags),
  "HS and Connections" (high school standards, one row per course; the
  build aggregates them into one entry per code with a `courses` list), and
  "Crosswalk" (2011 Common Core code and text -> 2026 code; `NA` = new in
  2026).
- **ELA workbook** — sheets read by the build: "ELA26 and Connections"
  (Washington 2026 ELA standards by grade, K through 11-12) and "Crosswalk"
  (2011 Common Core code and text -> one or several 2026 codes).
- **NGSS PDF** — read by `lib/standards/ngss.ts`: every `CODE. statement`
  line group (e.g. `MS-PS1-2.`), its optional `[Clarification Statement: ...]`
  and `[Assessment Boundary: ...]`, wrapped across lines and page breaks. A
  trailing `*` (engineering integration, 29 expectations) is stripped from the
  text and kept as `engineering: true`. Codes cited in parentheses elsewhere
  are references and are not read. The intermediate JSON is a sorted array of
  `{ code, text, clarification?, assessment_boundary?, engineering? }`.
- The other sheets (change log, glossary, bibliography, WIDA connections,
  interim assessment links) are not read.

## Data fixes the build applies

- The ELA crosswalk cites `ELA 11-12.W.3` (a space for the dot); the build
  reads it as `ELA.11-12.W.3`.
- The ELA crosswalk cites `ELA.11-12.R.5` in six rows, but the same
  workbook defines no such standard (grade 11-12 Reading has R.1-R.4 and
  R.6). Those six pairs are dropped, not guessed at.
- 22 high school math standards are worded differently per course; the
  entry keeps the first course's text and a course whose wording differs
  carries its own `text`.

## NGSS extraction notes

- 208 distinct expectations, K-5, K-2, 3-5, MS, HS across PS / LS / ESS / ETS.
- Two pages of the PDF's text layer (MS-LS3, MS-ESS1) carry a stray space
  after many letters ("E mphasis", "ty pes", "[C larification S tatement").
  The parser repairs those pages by joining letter runs whose joined form is
  a word on an undamaged page (plus "Punnett", which no undamaged page has).
- HS-PS1-2 prints "[Clarification Steatement:" (source typo); the tag's second
  word is read loosely and the text is not altered.

## License

- The xlsx files carry no license text. OSPI's 2026 standards PDFs state a
  Creative Commons Attribution license. Attribution: "Adapted from the
  Washington Office of Superintendent of Public Instruction, K-12 Learning
  Standards (2026), CC BY."
- The 2011 Common Core text inside the crosswalk sheets is shipped
  verbatim under the CCSS public license, notice: "© Copyright 2010.
  National Governors Association Center for Best Practices and Council of
  Chief State School Officers. All rights reserved."
- NGSS (slice 1b): copyright National Academies Press; trademark WestEd. The
  NGSS terms say "states, districts, schools, teachers and non-profit
  education entities may copy, reproduce, alter, adapt, edit, delete and
  rearrange any and all parts of the NGSS" (source:
  https://www.nextgenscience.org/ngss-trademarks-and-copyright/ngss-trademarks-and-copyright).
  Notice: "Next Generation Science Standards is a registered trademark of
  WestEd. Neither WestEd nor the lead states and partners that developed the
  Next Generation Science Standards were involved in the production of this
  product, and do not endorse it." Project docs only, not shown to teachers
  (decision D-1b).

## To update

Workbooks: replace the file, update its sha256 and version here, run the build
script, review the JSON diff.

NGSS (two steps): download the new PDF, update `PDF_SHA256` in
`scripts/extract-ngss.ts` and the row above, run
`bun run standards:extract-ngss <pdf>`, review the intermediate JSON diff,
update its sha256 in `scripts/build-standards.ts` and here, then run
`bun run standards:build` and review the `catalog.json` diff.
