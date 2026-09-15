# Secure Test — pilot quick-start

For the teachers and students in the first classroom pilot (from
2026-09-17, on **2026 AP Seminar EOC B v2**). One page each: what to do, in the order you do it, and the
things that look wrong but aren't. Written against client v1.3.2 and the
design tool as deployed 2026-09-15. Nothing here needs IT on the day;
the student Macs already carry the app and its configuration profile.

Send anything odd with the **Send feedback** button in the design tool's
header (top right). It reaches the project maintainer as an email with the
page you were on.

---

## Teacher — the pilot assessment

The pilot uses **2026 AP Seminar EOC B v2**, already shared with you. Its
reading layout is set (sources beside the question, one question at a
time) and its rubric is attached.

1. **Sign in** at the design tool with your school Google account. You land
   on **Assessments**. The shared assessment sits under **Shared with you**.
2. Press **Add to my assessments**. You now own a **copy**; later edits to
   the original don't reach it, and yours don't reach anyone else's.
3. Open the copy. It arrives as a **Draft**. Look it over (*Show preview*
   renders it as the student will see it, minus the lockdown), then press
   **Publish**. Only a Published assessment can start a test session.
4. Leave **Settings → Time limit** blank unless you want the session to end
   itself; if set, the student's session ends at zero and their answers are
   kept.

## Teacher — building your own (after the pilot)

1. **Build or import.** *New assessment* for a blank one; *Import items from
   PDF* inside an assessment to read a paper test (it proposes questions and
   sources for you to accept); *Import assessment file* on the home page to
   load a `.json` a colleague shared.
2. **Reading layout.** For a passage or sources shared by several questions,
   the stimulus card's layout select has three choices. *Side by side
   (sources beside the question)* is the default whenever a stimulus carries
   sources. It needs **Settings → How students move through the test → One
   question at a time**, and it shows two columns only on a wide screen (a
   MacBook in full screen qualifies). Students get a *Sources: Beside |
   Above* switch.
3. **Publish.** A Published assessment is locked (a running test can't
   change). To edit, *Unpublish*, edit, *Publish* again — anyone already in
   a session keeps going on what they had.
4. **Share** with a colleague by staff email. They get their own copy.

## Teacher — on the day

1. Open the assessment → **Test sessions** tab.
2. **Who is it for:** *All my sections*, *One section*, or *Picked students*.
   Sections come from the district roster as of 06:00 this morning; a
   student who isn't enrolled in your section can't join.
3. **How long:** *This period · 55 min* (default), *90 min*, *Rest of day*,
   or a number of minutes. This is how long the session stays **open for
   joining**; it is not the student's time limit (that is Settings).
4. **Start session.** A six-character **Session code** appears. Students in
   the chosen sections see the test under **Your tests** without the code;
   the code is for a student whose list is empty.
5. **Monitor** shows every student: *Not joined · In progress · Idle ·
   Needs attention · Handed in*. **View screen** shows one student's screen
   once (they see a notice that you looked). **Hand in** submits for a
   student who left without finishing — it is enabled once the session is
   closed or the time limit has passed.
6. **Close session** when everyone is done. Students still in the test keep
   working until they hand in or their time limit ends.

## Teacher — after

- **Results**: one row per student, one column per question, totals and
  percent. *Download CSV*, *Print report* (a printable summary; add
  `?attempt=…` from a student's row for a family-facing single page),
  *Print student work* (each student's answers with the key on a last
  page, for scoring by hand or evidence).
- **Scoring queue**: essays and hand-scored items wait here. A rubric can
  be uploaded on the question (PDF, Word, Markdown or plain text); with a rubric, *Score
  with AI* proposes a score and feedback you approve or change. Nothing
  reaches the student until you approve it.
- A student's row can be **deleted** (per-student results page or the
  Monitor) once the session is closed, for a false start. There is no
  undo.

## Student

1. Open **Secure Test** from Applications (or the Dock). Press **Sign in
   with Google** and sign in with your school account. You sign in every
   time the app opens.
2. **Your tests** lists what is open for you right now. Press **Join**. If
   your teacher gave you a **Session code**, type it and press **Join**
   instead.
3. The Mac locks: the menu bar, Dock, other apps and notifications go away
   until you hand in. That is expected.
4. Move with **Previous / Next** or the numbered strip; green means
   answered. Sources sit beside or above the question — the *Sources:
   Beside | Above* buttons move them.
5. **Finish and hand in** on the last page. After that press **Back to
   your tests**.
6. If you need to leave early, **End secure session** (top right) unlocks
   the Mac and takes you back to **Your tests**. Your answers are saved;
   press **Resume** on the same test to continue, as long as the session
   is still open.

---

## Things that look wrong but aren't

- **"0 of 1 answered" while a student is typing an essay.** An essay
  saves when the student leaves the field (clicks elsewhere, turns the
  page, hands in). The Monitor catches up on the next poll.
- **A student's session ended by itself.** Either the teacher's time limit
  ran out ("Time is up." on the student's screen, answers kept) or the Mac
  is still on client v1.3.1, which ends every session after ten minutes.
  About Secure Test shows the version; v1.3.2 fixes it and the fleet
  updates on its own a few times a day.
- **Sources appear above the question, not beside it.** The assessment's
  Settings is *One scrolling page*, or the stimulus layout is not *Side by
  side*, or the window is narrower than about 1100 px.
- **Delete draft is greyed out.** A Published assessment must be
  unpublished first; an assessment with attempts can only be archived.
- **"No tests assigned right now."** No session is open for a section the
  student is enrolled in today. Read them the Session code.
- **"This Mac isn't set up for Secure Test yet."** The configuration
  profile hasn't reached that Mac. IT, not the teacher.
- **Wi-Fi drops mid-test.** Answers are stored on the Mac and sent when the
  connection returns; hand in again if the first attempt reports a
  failure.
- **A dollar amount like $57,600 in a passage.** Renders as plain text; a
  `$` before a digit is never math.

## Not in this pilot

- Gradebook export to PowerSchool / Schoology (a CSV is available).
- Rescoring already-scored answers after an answer key changes.
- Handwriting or drawn math recognition (a keypad is available on short
  answers whose question contains math).
