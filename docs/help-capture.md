# Help-page screenshots — the capture recipe

The help page (`design-tool/public/help.html`, planned) shows the teacher tool
with a **fictional** class. Screenshots are taken from a separate local
database, `secure_test_design_tool_demo`, that holds nothing but the demo
roster — never from the dev database, which carries the real demo accounts,
and never from the origin. This repository is public: a screenshot is a
tracked file like any other.

## 1. The demo database (once; re-run the seed any day)

```bash
createdb secure_test_design_tool_demo
cd design-tool
DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_demo bun db/migrate.ts
DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_demo bun --env-file=.env.local scripts/seed-demo.ts
```

`scripts/seed-demo.ts` refuses any database whose name does not end in
`_demo`. It loads `lib/dev/demoRoster.ts` through the real importer:

- Teacher `demo.teacher@psd401.net` — AP Biology (P1), Biology (P3),
  English 10 (P5).
- Co-teacher `demo.coteacher@psd401.net` on English 10.
- 30 made-up students (`firstname.lastname@edtools.psd401.net`, ids
  7001–7030, SSIDs `WA-DEMO-7001`…), a few in two sections.

Its last line is the demo teacher's session cookie
(`secure-test-session=…`, 8 hours).

## 2. The app against the demo database

Stop any other dev server first (one `next dev` per checkout), then:

```bash
cd design-tool
DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_demo bun run dev
```

A `DATABASE_URL` set on the command line wins over `.env.local`.

## 3. Sign in as the demo teacher

In Chrome on `http://localhost:3000`, set the cookie printed in step 1
(DevTools console): `document.cookie = "secure-test-session=<token>; path=/"`,
then open `/dashboard`.

## 4. Content (as captured 2026-09-25)

Build it through the UI as the demo teacher — the building is part of what
the help page shows. Files are in `design-tool/scripts/help-capture/content/`.

- **Cell Structure Check-in** (30 min): New assessment; question 1
  (multiple choice) typed in the editor; questions 2–5 pasted into
  **Import items from CSV** from `cell-structure-items.csv`; a Matching
  question (Nucleus → Stores the cell's DNA, Ribosome → Builds proteins,
  Mitochondrion → Releases energy from food) and an Ordering question
  (DNA is transcribed into mRNA in the nucleus → mRNA leaves the nucleus →
  A ribosome reads the mRNA → The protein is packaged by the Golgi
  apparatus) added with the type picker. Publish; start a session for
  AP Biology.
- **Sunday Library Hours: Source Analysis**: home → **Import assessment
  file** → `sunday-hours.json` (three fictional sources, side by side).
- **Photosynthesis Quiz**: New assessment → **Import items from PDF** with
  the file from `bun scripts/help-capture/make-pdf.ts <out.pdf>` (local dev
  runs the mock extractor, which reads its markers) → **Add all**.
- **Students taking the test** (Monitor, scoring queue, results): with the
  session open on the Monitor,
  `bun --env-file=.env.local scripts/help-capture/sim-students.ts <CODE> scripts/help-capture/content/monitor-plan.json`
  drives ten demo students through the student API (join, answer, one
  leaves the test window, five hand in) over about 40 seconds. A student
  has one attempt per assessment: a re-run needs a fresh assessment or
  deleted attempts.
- One accommodation (Color Contrast, Yellow on Black) on Avery Brooks via
  **Students → Add support**.

Typing through Chrome automation drops characters while the editor
re-renders; set field values with the native value setter plus an `input`
event instead, and keep real clicks for buttons. A native `<select>`
changed that way only takes effect once the page has hydrated.

## 5. Capturing

Chrome must be in front with the Claude tab visible and localhost zoom at
100% (⌘0) — a hidden or zoomed tab gives blank or scaled captures. Hide the
Next.js dev badge first (`nextjs-portal { display: none }`) and move the
pointer off the page.

- **Stills.** Chrome's screenshot action returns no file, so record one
  frame instead: start the recorder, run a batch of *hover + screenshot* (a
  frame is kept only after an action), stop, export with every overlay off
  and quality 1 as `<name>.gif`, then
  `scripts/help-capture/still.sh <name> <w:h:x:y>` → `public/help/<name>.png`.
  Crop to the content column (e.g. `900:694:285:52` below the header band).
- **GIFs.** Record the steps with a *hover + screenshot* after each (extra
  frames = a longer pause), export with click indicators and progress bar
  on, labels and watermark off (James, 2026-09-25), as `<name>-raw.gif`, then
  `scripts/help-capture/anim.sh <name>-raw <name> <seconds-per-frame> <crop>`
  → 900 px wide, last frame held 3 s.

## 6. Before committing a screenshot

- Only demo names, demo emails and fictional assessment content on screen.
- No hostname other than `localhost`, no real session codes that matter.
- Each still well under 200 KB, each GIF under ~1.5 MB.
