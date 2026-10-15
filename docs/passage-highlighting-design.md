# Passage highlighting (roadmap U-21) — design note

Status: **draft 2026-10-14, nothing built.** Decisions already made by James
(2026-10-13, roadmap row U-21): **5.2** this sitting only — no storage, no
bridge message; **5.3** a per-assessment checkbox "Let students highlight
passages"; **5.4** one colour plus "remove highlight"; **5.5** not shown to
the teacher; **5.6** served-renderer work. 2026-10-14: the design note and a
spike now, build timing decided from the spike; **the setting is held back
from clients below 2.0** (22.3).

## What a beta teacher asked for

Students reading a stimulus passage or a multi-source set mark the lines
they will come back to, the way they would on paper.

## What stands in the way

1. **The test page turns text selection off.** `PageShell.swift` sets
   `user-select: none` on everything outside answer fields (lockdown: no
   dragging text out, no selecting the page). A browser selection is what a
   student would use to say "this part".
2. **WebKit paints no `::highlight` under `user-select: none`.** Learned on
   read-aloud's word highlight (2026-10-01): the block being read opts back
   in to `user-select: text` for as long as it is read (`.tts-reading`).
3. **Copy is denied page-wide** unless the teacher allows the clipboard
   (`ALLOW_CLIPBOARD`, slice 69: `document.oncopy` / `oncut` / `onpaste`
   refuse). Opening selection on passages therefore does not open copy:
   a selected passage still cannot be copied into an essay.

## Proposal

- **Setting.** `assessments.allow_highlighting` (boolean, default false);
  the Settings tab checkbox "Let students highlight passages"; carried on
  the delivery bundle as `allow_highlighting: true` only when on — and
  **only to a client that reports 2.0 or later** (the
  `X-SecureTest-Version` header, as `lib/items/clientSupport.ts` reads it).
  Editable while Published, like the other student-facing options. Export /
  import / Duplicate carry it.
- **Where.** Stimulus bodies (`.stimulus-body`) and multi-source panels
  (`.source-body`), nowhere else — not stems, not answers.
- **Selecting.** With the setting on, those two containers opt in to
  `user-select: text`. Copy stays governed by `ALLOW_CLIPBOARD` as today.
- **Marking.** On a non-empty selection inside one passage, a small
  "Highlight" button appears beside it; pressing it wraps the selected text
  in `<mark class="st-mark">` elements (one per text node the range
  crosses, so it survives line breaks, links and inline math), then clears
  the selection. Marks are DOM, not `::highlight`, so they paint whatever
  `user-select` says and travel with the passage when paging moves it
  (`passage-holder` moves the block, it does not rebuild it).
- **Removing.** Pressing a mark (or Enter / Space on it) offers "Remove
  highlight"; removing unwraps that mark. "Clear highlights" on the passage
  removes them all.
- **Colour.** One mark colour per contrast set (8 sets), checked for 4.5:1
  text contrast on every set, as the contrast-pair work did (D-B4).
- **Lifetime (5.2).** Page memory only: lost on quit, relaunch and resume.
  No response, no bridge message, no `requires` term.
- **Teacher (5.5).** Nothing on the teacher side but the checkbox.

## Keyboard and VoiceOver — the open part

A mouse selection is the easy half. Static text has no caret, so a keyboard
user cannot make a selection with Shift-arrows the way they can in a field.
Candidates, to settle in the spike:

- **(a) VoiceOver's own text selection.** VoiceOver can select text in web
  content (VO-Return to start and stop selecting while reading). If the
  selection it makes reaches the page as a DOM selection, the same
  "Highlight" button works.
- **(b) A sentence cursor.** In a passage, a "Highlight mode" lets the
  student move sentence by sentence with the arrow keys and press Space to
  mark or unmark the current sentence. Self-contained and predictable;
  coarser than a free selection.
- **(c) Mouse only for v1 of the feature**, keyboard later. Simplest; not
  an equal tool.

VoiceOver must hear a mark: WebKit exposes `<mark>` as "highlighted" in
recent macOS versions — to confirm in the spike, with `aria-roledescription`
or a hidden "highlighted" word as the fallback.

## The rollout gate (22.3)

v1.x clients render their built-in page, which has no highlighting. The
server sends `allow_highlighting` only to a client reporting 2.0+, so a
v1.x student sees the test exactly as today. **Open (H-1):** is that
enough, or should a highlighting test refuse v1.x clients with the
"update SecureTest in Self Service" sheet (the fill-in-the-blank gate), so
every student in the room has the tool? Refusing is fairer; not refusing
lets every student test while AutoPkg moves the fleet (next-day).
Recommendation: do not refuse — highlighting is an aid, not part of
answering, and the fleet is on 2.0 within a day or two of release.
**DECIDED (James, 2026-10-14): do not refuse.** Reversible with a deploy
alone: the refusal would be one entry in the server's client-support table
(`lib/items/clientSupport.ts`, 409 `client_update_required`), which every
client since 1.6.0 already shows as the update sheet — no client release.

## Spike (before any build)

Debug client, simulated lockdown, a local fixture with an inline stimulus,
an own-page stimulus and a multi-source set; throwaway code in the page
behind a flag. Then one real AAC session.

1. With `user-select: text` on `.stimulus-body` inside the locked page: can
   the mouse select, and does the selection stay inside the passage?
2. Wrapping a range across two paragraphs, a link and inline KaTeX in
   `<mark>`s: rendering, and the passage's read-aloud afterwards (word
   ranges are computed from text nodes — marks split them).
3. Copy with the clipboard locked: still refused.
4. Paging: marks survive Next / Previous on an own-page passage.
5. VoiceOver: is a mark heard? Does VoiceOver's text selection (a) reach
   the DOM selection?
6. A real AAC session: 1 and 3 again inside the lock.

Spike result decides: keyboard model (a / b / c), the read-aloud
interaction, and whether the build fits before v2.0 or follows it.

## Slices (after the spike)

1. Server: migration (`allow_highlighting`), Settings checkbox, bundle
   field gated to 2.0+, export / import / Duplicate, rows.
2. Page: selection opt-in, mark / remove / clear, colours per contrast set,
   JSC-harness tests (wrap across nodes, unwrap restores the text exactly,
   no marks outside passages, nothing posted).
3. Keyboard + VoiceOver per the spike.
4. Rows in `client/MANUAL-CHECKS.md` and `docs/design-tool-manual-checks.md`;
   help page topic + quick start line.

## Progress

- 2026-10-14 — note drafted; H-1 decided (do not refuse); spike next.
- 2026-10-14 evening — **spike, mouse half** (Debug build of `main` +
  throwaway code on branch `spike/highlight`, offline `--bundle` with a
  three-paragraph passage containing inline KaTeX; windowed, clipboard
  locked). Results:
  - **1 ✅ Selecting inside the locked page works** once `.stimulus-body` /
    `.source-body` opt in to `user-select: text`; a drag across paragraphs
    and a double-click on one word both make a normal selection, and the
    rest of the page stays unselectable.
  - **2 ◐ Wrapping works, two details for the build.** A whole word marks
    exactly ("captured"); a drag across two paragraphs marked them in one
    `<mark>`, since a `pre-line` body is one text node — so remove-by-click
    removes all of it. The build should split marks at paragraph breaks.
    The spike skipped text inside KaTeX on purpose, which left a visible
    gap over the formula; the build wraps a `.katex` span whole. One drag
    marked from the start of its paragraph rather than the first word
    selected — the boundary test must compare range points, not containers.
  - **Remove ✅** one click on a mark unwraps it and normalises the text.
  - **3 not run** — the automation refuses Edit → Copy; moves to the
    hands-on half (expected refused: `document.oncopy` denies it).
  - **4 not run** — the offline path renders scroll, not paged; a paged
    run needs local dev or the origin.
  - **5 / 6 not run** — VoiceOver and the real AAC session need James at
    the keyboard.
  - Read-aloud with marks present not yet tried (marks split text nodes).
- 2026-10-14 night — **spike, hands-on half** (James, same spike build,
  offline, windowed):
  - **3 ✅ Copy stays refused** with the clipboard locked: Cmd-C on a
    selected passage word left the clipboard unchanged (fingerprint
    checked before and after); Cmd-V into the short answer also did
    nothing (paste is refused too, so that alone proves nothing).
  - **5a ✅ VoiceOver hears a mark:** a highlighted word and a highlighted
    phrase are each announced as highlighted, the phrase once — WebKit
    exposes `<mark>` with no extra labelling.
  - **5b ❌ VoiceOver's own text selection does not reach the page:**
    VO-Return … VO-Return made no DOM selection, so the Highlight button
    never appeared. Keyboard option (a) is out; the choice is (b) a
    sentence cursor or (c) mouse-only first (open, James).
  - **Testing method (James):** twice during VoiceOver the Claude desktop
    app went to 100 % CPU and stopped responding (first time it crashed).
    VoiceOver checks run with the Claude app quit or hidden, with the
    steps written down beforehand and results reported after.
  - Still open: 4 (paging — becomes a JSC-harness test in the build), 6
    (a real AAC session — joins the build's hand-run rows), read-aloud
    with marks present.
- 2026-10-14 night — **keyboard model DECIDED (James): (b) the sentence
  cursor.** A "Highlight mode" on the passage: arrow keys move sentence by
  sentence (the current sentence outlined), Space marks or unmarks it,
  Escape leaves the mode; VoiceOver hears the sentence and its highlighted
  state. Mouse selection stays alongside. The spike worktree and branch
  are deleted. Next: the build, slices 1–4 above (server setting gated to
  2.0+ → page marking → sentence cursor → rows).
- 2026-10-14 night — **slice 1 BUILT + PUSHED (`d230906`), deploy HELD until
  v2.0 (James).** **Slice 2 BUILT** (page, mouse only, on `main` — the
  served renderer is extracted from it): passages opt in to selection, a
  Highlight button under a one-passage selection, marks split at blank
  lines, formulas wrapped whole, boundary points placed by an ordered walk
  (testable without a live Range), click a mark to remove it, "Clear
  highlights" per passage, nothing posted or stored; mark colours per
  contrast set 5.23:1–19.56:1 plus an underline so marks show without
  colour (James); read-aloud reads a marked passage whole. Decision 31.1
  (James): the teacher's View screen showing the student's marks is
  accepted — a glimpse, not a record. Readings: a word cut by a mark edge
  gets a partial word highlight; adding a mark mid-reading drops the word
  highlight for the rest of that reading. Not verified in WebKit yet:
  button position, the press keeping the selection, scroll hiding it —
  slice 4 rows. Tests: swift 1017, renderer 62, extraction byte-identical.
- 2026-10-14 night — **slice 3 BUILT** (sentence cursor, on `main`): a
  "Highlight mode" toggle per passage (tabindex, aria-pressed); in the mode
  arrows move by sentence, Home / End, Space / Enter mark or unmark (a mark
  reaching past the sentence is split so only that sentence loses it),
  Escape returns to the toggle, blur leaves; outline in the focus-ring
  token; a polite live region announces the instruction, each sentence
  (led by "Highlighted: " / "Partly highlighted: " — first, not last, since
  2026-10-15, James) and "Highlighted" /
  "Highlight removed". Splitter: `. ! ?` before whitespace or end, blank
  lines; decimals and a short abbreviation list stay whole; limits =
  initials, "... " ellipses, other abbreviations, single line breaks.
  Agent choices accepted (James): "partly highlighted"; `role="application"`
  on the passage in the mode so VoiceOver passes arrows through (hand-run
  must confirm); no redraw on resize until the next key; re-entry starts at
  the first sentence. Tests: swift 1034 (16 new), renderer 62, extraction
  byte-identical. Next: slice 4 — rows, help page, quick start; rows run in
  one sitting on a Debug build against local dev, VoiceOver with the Claude
  app quit or hidden.
- 2026-10-14 night — **slice 4 docs pushed (`05776a7`); hand-run, first
  pass** (Debug of `05776a7`, offline bundle with the flag, computer use;
  `client/MANUAL-CHECKS.md` "Passage highlighting"): rows 1, 2, 4–7, 10–13
  ✅, 3 and 14 ◐. Readings, all cosmetic, proposals only: **H-2** the
  sentence outline crosses through an inline formula; **H-3** the first
  mark inserts "Clear highlights" above the passage and shifts the text a
  line; **H-4** the mark's underline does not run under a formula; **H-5**
  at 3X zoom the floating Highlight button covers the next line while it
  shows. Left for James: 8 (Cmd-C), 9 (scroll a source panel), 16
  (VoiceOver in Highlight mode — Claude app quit or hidden), 17 (read
  aloud with marks); 18–19 at the v2.0 RC.
- 2026-10-14 night — **H-2…H-5 FIXED** (James: fix the cosmetics first) and
  re-checked on a fresh Debug build: one outline box per line wrapping a
  formula (H-2); "Clear highlights" sits beside "Highlight mode" and is
  hidden, not removed, while empty, so the passage never moves (H-3); the
  underline is an inset bottom shadow that reaches formulas (H-4); the
  Highlight button sits above the selection, below only near the window
  top (H-5). swift 1039. Rows left for James: 8, 9, 16, 17; 18–19 at the
  v2.0 RC.

