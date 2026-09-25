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

## 4. Content

Build assessments in the UI as the demo teacher — the building is part of
what the help page shows. For results, scoring and Monitor screenshots,
run a sitting with a demo student (`scripts/mint-student.ts
<first.last>@edtools.psd401.net` → the client's `SECURE_TEST_TOKEN`), or
fabricate submitted attempts with `scripts/seed-attempts.ts <assessment-id>`
(it uses the owner's roster students first).

## 5. Before committing a screenshot

- Only demo names, demo emails and fictional assessment content on screen.
- No hostname other than `localhost`, no real session codes that matter.
- Crop browser chrome; 2× PNG, then compress.
