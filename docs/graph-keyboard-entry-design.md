# Graph it: keyboard placement only, no typed coordinates (design, 2026-11-13)

Status: **DECIDED (James, 2026-11-13): Q1–Q5 as recommended below.** Amends D-9 and D-11 in
`docs/graphing-calculator-design.md`.

## Why

On the 2026-11-13 staging hand-run (corrections mode), James found that the
Graph it board's typed-coordinate form ("Point at (2, 3) Add") lets a student
add an object without using the grid. A question that asks a student to
*locate* points on a coordinate plane then measures nothing about the plane.
Typed entry was added under D-9 as the WCAG 2.1.1 keyboard-equal alternative
to clicking. Of two options (A: a per-question teacher toggle to hide typed
entry, on by accommodation; B: replace typed entry with arrow-key movement on
the grid), **James chose B.**

## What exists today

`packages/graphing/src/ui/graphAnswer.ts` (`mountGraphAnswer`) already has
three ways to place a point, all making the same objects:

1. **Click** — each click snaps.
2. **Keyboard on the board** — the board (`role="application"`, tabbable)
   takes Arrow keys (move a cursor one snap step, clamped to the board),
   Enter / Space (place at the cursor, in the tool's click order), Escape
   (cancel a pending first point). Each move announces `(x, y)` through a
   polite live region. Tab leaves the board (no trap).
3. **Typed form** — tool select + x/y text fields + Add.

So Option B is mostly **removing (3) from the student board** and filling
two gaps in (2). It was hand-checked in a real AAC session on 2026-10-24
(`client/MANUAL-CHECKS.md`, Graph it row: "click, arrows + Enter, typed
coordinates").

## Design

### Keyboard model (student board)

| Key | Does | Change? |
|---|---|---|
| Tab / Shift-Tab | Into / out of the board; the cursor ring shows only while the board has focus | none |
| ← → ↑ ↓ | Move the cursor one snap step; stops at the board edge (`snapInside`) | none |
| Shift + arrow | Move one **grid line** (`board.grid`), or 5 snap steps when grid = snap | **new** — a −10…10 board at snap ½ is 40 presses edge to edge |
| Enter / Space | Place at the cursor | none |
| Escape | Pending first point → cancel it ("Cancelled."). Nothing pending → focus returns to the selected tool button | **new second half** — D-11's "Esc exit from the graph" (2.1.2) was only half built |

Where the cursor starts: the board's centre, snapped (today). It stays where
the last point was placed. No Home / jump-to-origin key: jumping to a named
place is the shortcut this change removes.

**Multi-point tools** keep the click order already in `TOOL_HINTS`: Enter
once sets the first point (line/segment: a point; ray: the endpoint; circle:
the centre; parabola: the vertex) and the announcement says what the next
Enter places; Enter again completes the object. The same `placeable` checks
apply (same point twice, parabola second point level with or straight above
the vertex, max objects) and are announced. Escape drops the first point.
Undo, Clear all and per-object Remove stay as they are.

### What VoiceOver announces (Q1 — decided: keep the coordinates)

The conflict: a screen-reader user has no way to know where the cursor is
except by being told. Announcing `(2, 3)` on every move is what makes the
board operable without sight (1.1.1 text alternative, 4.1.2 name/value), but
it is also the coordinate the question may be asking for.

**Decision: keep announcing the coordinates on every move** (today's
behaviour), and record why it does not defeat the item:

- The student still has to *navigate*: know that x is left–right and y is
  up–down, which direction is negative, and count steps from where they are.
  That is the non-visual equivalent of reading the axis labels — the same
  thing a tactile graph gives a braille reader. Typing `2, 3` asks for none
  of it.
- The live region is silent without a screen reader, so a sighted keyboard
  user sees only the ring on the grid and must read the plane.
- The alternatives are worse: relative-only speech ("right 1, up 2") makes
  the item harder for a blind student than for anyone else (an unequal
  test, not an equal one), and silence makes the board unusable (fails
  2.1.1 for that student).

The board's label stays as is (extent, given objects, key help) and gains
"Shift with an arrow moves one grid line; Escape leaves the graph."

### Typed entry elsewhere

- **Student board (client): gone, for everyone.** No teacher toggle, no
  accommodation in this change (Q2). Voice Control ("press right arrow 3
  times") and switch access drive arrow keys, so the keyboard model covers
  2.1.1 without typing.
- **Teacher's key board (design tool `GraphItemEditor.tsx`): keep it.**
  Typing an exact key is not a construct problem and is faster for teachers.
  `mountGraphAnswer` gains `typedEntry?: boolean` (default **false**); only the
  design-tool key editor passes `true` (Q3). Review / read-only boards are
  unchanged (no entry at all).

### What students still see in words (Q4 — decided: its own roadmap row)

The object list under the board reads each object back ("point (2, 3)",
"y = 2x + 1"), visible to everyone. For a "plot (2, 3)" question that is
only confirmation after placing on the grid. For a "graph y = 2x + 1"
question, a student can place points by trial and read the list until it
says the target equation — a guess-and-check route around slope and
intercept. Not part of this change; raised so it can be decided separately
(e.g. a per-question "show answers in words" setting, with the list then
naming objects "Line 1" for Remove and screen readers).

## Release path

- **Page script only.** The board ships inside the served, signed renderer
  (`GeneratedGraphing.swift` → `packages/renderer` extract), which every 2.0+
  client loads; the delivery route names the *current* renderer, not one
  pinned per attempt. So: **no client release, no `MIN_CLIENT_VERSION_FOR_TYPE`
  change** (`graph` is already 2.0.0), **no renderer floor** (nothing new on
  the wire; a floor only gates bundle fields an older renderer can't honour).
  Ships at the next `deploy.sh` with a re-signed renderer.
- **Saved answers are unaffected.** Typed entry already enforced snap and
  bounds, so every saved object is on-grid and restores onto the board on
  resume. The response shape (`{type: "graph", objects}`) is unchanged.
- **Rollback:** `renderer-pointer.sh set <previous>` brings typed entry back;
  nothing else depends on it.
- If Q2 adds an accommodation that re-enables typed entry, that IS a new
  bundle field and needs a renderer floor (`MIN_RENDERER_VERSION_FOR_…`,
  set from the merge commit's time as in slice 3d). It fails open (old
  renderers show typed entry to everyone), so below the floor nobody is
  refused.

## Tests

The board has no DOM tests (it can't run in bun or JavaScriptCore), so the
key handling is pure functions in `graphAnswer.ts`, tested in
`packages/graphing/test/graphAnswer.test.ts`:

- `moveCursor(cursor, key, shift, board, snap)` — one snap step, up = +y;
  Shift = `bigStep` (one grid line; 5 steps when grid ≤ snap); clamps at
  every edge, including bounds that aren't snap multiples; 30 steps of ⅓
  land exactly on 10; non-arrow keys return null.
- `boardKeyAction(key, pending)` — Enter / Space place; Escape cancels when
  a first point is pending and leaves otherwise.
- A line placed from the keyboard reads back "y = 2x + 1".
- A source check: the form is appended only for `typedEntry === true`.

Swift (`GraphAnswerShellTests.testTheStudentsBoardHasNoTypedCoordinates`):
the client's page glue never mentions `typedEntry`, and the vendored
`GeneratedGraphing.swift` (regenerated) carries the guard.

## Hand-check rows

In `client/MANUAL-CHECKS.md`, "Graph it: keyboard placement only, no typed
coordinates (2026-11-13)": no typed entry; arrows + Enter; Shift + arrow;
two-point tool; Escape twice; edges; VoiceOver (James); resuming an old
typed answer; the teacher's key board keeps typed entry.

## Slice (one PR)

`graphAnswer.ts` (`typedEntry`, Shift step, Escape leaves, label, pure
helpers + tests); the design-tool key editor passes `typedEntry: true`;
teacher text that promised typed entry (`renderHtml.ts` preview line,
`/help.html` Graph it bullet); `GeneratedGraphing.swift` regenerated;
MANUAL-CHECKS rows; D-9 / D-11 amended; roadmap Row DC-R (Q4). Then deploy
+ re-signed renderer, then the hand rows (James, real AAC for VoiceOver).

## Decisions (James, 2026-11-13)

- **Q1** VoiceOver keeps saying "(x, y)" on each move — yes, with the rationale above.
- **Q2** No accommodation brings typed entry back (not in v1).
- **Q3** The teacher's key board keeps typed entry (`typedEntry: true`).
- **Q4** The visible readback's guess-and-check route gets its own roadmap row (a per-question setting to hide it), not this change.
- **Q5** Shift + arrow moves one grid line (5 snap steps only when grid = snap).
