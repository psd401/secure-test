# Secure Test — pilot quick-start

For the teachers and students in the first classroom pilot (from
2026-09-17, on **2026 AP Seminar EOC B v2**). One page each: what to do, in the order you do it, and the
things that look wrong but aren't. Written against client v1.3.3 and the
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
4. **Time limit** (Settings) is set to 55 minutes for the pilot. It is
   counted per student from the moment they open the test. See "Three
   clocks" below before you start a session.

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
5. **Duplicate** (on the home list row, or the Settings tab) makes your own
   Draft copy — "(copy)" — with the questions, sources, accommodations and
   settings; results and test sessions are not copied. Use it for a second
   period's version or before a big edit.

## Teacher — practise on your own Mac

Sit your own test exactly as a student will, locked down, before your class
does. **Needs Secure Test on your own Mac** — district IT is adding teacher
Macs; until yours has it, this button has nothing to open.

1. Open a **Published** assessment → **Test sessions** → **Practice on my
   Mac**. A practice session opens for the rest of the day, for you alone.
2. Open **Secure Test** on your Mac and sign in with your school Google
   account. The test is under **Your tests** (the session code works too).
   It is the real thing: full screen, locked, the same exits, time limit,
   paging and hand-in your students get.
3. Back on the Test sessions tab, the practice row shows how far you got.
   **See my answers** opens your answers and score; **Practice again**
   clears them so you can start over.

Practice never shows up in your results, Monitor, scoring queue, Students
page or printouts, and nobody else sees it. It is deleted a week after the
practice session ends. Until your Mac has the next Secure Test update, the
test's label under Your tests reads like a class test; nothing else differs.

## Three clocks — what actually ends a student's test

All three stop a student who is already working; only **Hand in** finalises
their work.

1. **The test time limit** (Settings, 55 minutes). Per student, from the
   moment that student opens the test. At zero the student's Mac ends the
   secure session on its own ("Time is up."), their answers are kept, and
   the server accepts nothing more after a 30-second grace. Leaving and
   resuming does not restart it. **Adjust time** (beside Hand in everyone,
   or on one student's row) moves the deadline to a time you pick, later or
   earlier — the default is today at 11:59 PM; for a class finishing
   tomorrow, pick tomorrow, start a new session tomorrow and close it when
   they are done. Choose **No time limit** in the same dialog to take the
   limit away — from the header it also covers anyone who joins that
   session later; tick students on the Monitor and use **Adjust time for
   selected** for just those. On Secure Test 1.3.5 or later, a student
   already in the test sees their countdown disappear within a few seconds,
   with a notice; on older versions it keeps counting until they leave and
   **Resume** (at zero the Mac ends the session as usual and they resume
   with no limit).
2. **The session length** ("How long" when you start a session) and
   **Close session**. When the session runs out or you close it, every
   student still inside is returned to **Your tests** within a few seconds
   ("Your teacher ended the test session. Your answers are saved."). Their
   work is NOT handed in: the attempt stays in progress, and they can press
   **Resume** with everything intact the next time you open a session for
   them. The Close dialog tells you how many students are still working.
   The field a student is typing in at that instant is saved too, as long
   as their Mac is awake and online (a few seconds of grace).
3. **Hand in** on the Monitor. Your hand: it submits a student's work as it
   stands. The button is enabled once the session is closed or that
   student's time limit has passed. **Hand in everyone** (beside Close
   session) does the same for every student still working in one press —
   the dialog names how many. Nothing is scored or reported until the
   attempt is handed in — by the student's own **Finish and hand in**, or by
   you.

So with a 55-minute limit and a 55-minute session, a student who joins ten
minutes late is returned to Your tests when the session ends at minute 55;
press **Hand in** on their row to finalise, or open another session and they
continue where they left off.

**Macs still on client v1.3.2** (About Secure Test shows the version; the
fleet updates to v1.3.3 on its own): the screen keeps going after Close, but
nothing the student does after that is accepted. Say "Finish and hand in"
before you close, or rely on the 55-minute limit, which ends the session on
its own.

## Teacher — on the day

1. Open the assessment → **Test sessions** tab.
2. **Who is it for:** *All my sections*, *One section*, or *Picked students*.
   Sections come from the district roster as of 06:00 this morning; a
   student who isn't enrolled in your section can't join.
3. **How long:** *This period · 55 min* (default), *90 min*, *Rest of day*,
   or a number of minutes. This is how long the session stays **open for
   joining and resuming**; it is not the student's time limit (that is
   Settings, clock 1 above).
4. **Start session.** A six-character **Session code** appears. Students in
   the chosen sections see the test under **Your tests** without the code;
   the code is for a student whose list is empty.
5. **Monitor** shows every student: *Not joined · In progress · Idle ·
   Needs attention · Handed in*. **View screen** shows one student's screen
   once (they see a notice that you looked). **Hand in** submits for a
   student who left without finishing — it is enabled once the session is
   closed or the time limit has passed.
6. **Close session** when everyone is done. Students still in the test are
   returned to Your tests with their answers saved (clock 2 above) — the
   dialog says how many. Their rows stay *In progress*; press **Hand in
   everyone** (or **Hand in** on a row) to finalise, or open another
   session for them to continue.

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
7. If your screen says **"Your teacher ended the test session."**, the
   session was closed or ran out. Your answers are saved; the test comes
   back under **Your tests** with **Resume** when your teacher opens
   another session.

---

## Things that look wrong but aren't

- **"0 of 1 answered" while a student is typing an essay.** On client
  v1.3.4 and later, typed text saves on its own a few seconds after the
  student pauses (and at least twice a minute while they type), so the
  Monitor catches up on the next poll. On v1.3.3 and earlier an essay
  saves only when the student leaves the field (clicks elsewhere, turns
  the page, hands in).
- **A row says Idle while the student is clearly writing.** Idle means no
  answer has been saved for 10 minutes. On v1.3.3 and earlier an essay
  saves only when the student leaves the box, so Idle is normal
  mid-essay; from v1.3.4 the autosave clears it. View screen shows what
  they are doing.
- **A student is still working after I closed the session.** Their Mac is
  on client v1.3.2 (About Secure Test). Nothing they type after Close is
  accepted; press **Hand in** on their row. On v1.3.3 the Mac returns them
  to Your tests within a few seconds of Close (clock 2).
- **A student's row still says In progress after I closed the session.**
  Expected — Close returns them to Your tests with their answers saved but
  does not hand in. Press **Hand in** on their row, or open another
  session and they resume where they left off.
- **A student's session ended by itself.** Either the teacher's time limit
  ran out ("Time is up." on the student's screen, answers kept), the
  session was closed or ran out ("Your teacher ended the test session."),
  or the Mac is still on client v1.3.1, which ends every session after
  ten minutes. About Secure Test shows the version; v1.3.2 fixes it and
  the fleet updates on its own a few times a day.
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
