# 0016. Two wire formats — the teacher's export carries the answer keys, the student's delivery cannot express one

- **Status**: Accepted
- **Date**: 2026-08-25

## Context

`ItemBundleSchema` was built in Phase 2 as one format serving two audiences. The
export route said so in its own docstring: "the student client that will
eventually render the assessment, and teacher-to-teacher share/backup via POST
/api/assessments/import."

That was fine while the student client did not exist. When Phase 5 began, it
stopped being fine: the format carries `correct_choice_id`,
`correct_choice_ids`, `correct_answer` and `correct_region_ids`, and — for match
and order — the answer is carried by the STRUCTURE rather than by a named field.
`MatchItemSchema.pairs` puts each left beside its own correct right in one
object; `OrderItemSchema.sequence` is by definition stored in correct order.
Shipping that to a student's machine hands them the key to every item.

The keys cannot simply be removed from the shared format either. Teacher-to-
teacher share round-trips through `POST /api/assessments/import`, which reads
them straight back (`lib/api/importBundle.ts:269-372`), so key-bearing has to
remain the DEFAULT on that path.

Two constraints made this harder than a filter:

1. **The safe default for one audience is the lossy default for the other.** The
   route already reasoned about this for hidden rubrics and reached the opposite
   default; a flag that must be remembered on one path and not the other is a
   flag that will eventually be forgotten.
2. **The bundle is a file on the student's machine.** The same docstring says it:
   "a flag only holds if every future client honors it." Anything that depends on
   the reader behaving is not a control.

A third constraint arrived with match and order specifically: hiding their keys
requires translating the student's answer back on the way in, which needs a
per-attempt anchor. Attempts did not exist until slice 61.

## Decision

**Two types, not one type with a flag.**

- `ItemBundleSchema` (`packages/schema/src/items.ts`) stays exactly as it was:
  the teacher's export, carrying every answer key, round-tripping through import.
- `DeliveryBundleSchema` (`packages/schema/src/delivery.ts`) is the student's,
  and has **no field that can hold an answer key**. Not a filtered view — a
  separate discriminated union whose per-type members simply lack those fields.
  A route that leaked one has it dropped by the schema rather than shipped.

**Match and order get a shape change plus per-attempt identifiers**, because
deletion cannot reach a key carried by structure:

- Slice 51 split `pairs` into independent `lefts` and `rights` arrays and
  shuffled the rights, and emits `entries` for order. That removes the
  POSITIONAL giveaway.
- Slice 64 gives both sides per-attempt ids, `HMAC(secret, attempt : item :
  scope : realId)` truncated to 24 hex characters. That removes the IDENTIFIER
  giveaway — without it both halves of a pair derive from the same authoring id
  and the bundle re-pairs itself for anyone who reads it. `scope` is `"L"`/`"R"`
  for match and `""` for order, and is the entire reason match works.
- The ingest route translates back before storing, so what lands in
  `responses.response` is authoring ids and the Phase 3 scoring code — which
  knows nothing about sealing — keeps comparing the right things.

The ids are **derived, not stored**. Reversal is by recomputing the small
candidate set the server already holds, never by inverting the hash.

The delivery format also diverges where the audiences genuinely differ: it
carries `accommodations` as the EFFECTIVE per-student map (tool id → setting
value) rather than the assessment's authoring-side allowed list, and
`allow_clipboard` only when true.

## Consequences

**Easier**

- A leak requires adding a field to a type whose whole purpose is not having
  one — a deliberate act, not an omission. The delivery route's final
  `DeliveryBundleSchema.parse` is the backstop, and it proves the mapping did not
  smuggle anything through.
- Derivation means no map table to keep in step with an item edit, a re-fetch
  yields the same ids (a student who reconnects mid-test must not find their
  options renamed), and two students in one sitting get different ids for the
  same option, so comparing screens reveals nothing.
- The two audiences can now diverge on purpose. Per-student accommodations and
  the clipboard policy are meaningless in a teacher's backup and essential in a
  student's bundle.

**Harder**

- Two formats to keep in step. Every new item type needs a member in both unions
  and a branch in both mappers. `assertNever` on the type switch makes the build
  fail when `ITEM_TYPES` grows without one, which is the guard that makes this
  survivable.
- **Client tests must never name an authoring id.** They did, and slice 64 broke
  them: they now look options up by the text a student would read. That is the
  honest shape anyway — the client is not supposed to know what an id says.
- **A secret now governs whether a student can read the key.** It falls back to
  `DESIGN_TOOL_SESSION_SECRET` and warns once when it does. The sharp edge is
  rotation: with one key doing both jobs, rotating the session secret for an
  unrelated reason silently renames the match/order options of every in-progress
  attempt. Rotate between sittings, never during one.
- Anything sealed is unreadable in a raw bundle dump, which makes a support
  question about one student's answer harder to eyeball.

**Known limit**

Sealing protects the bundle, not the screen. A student who can see the item can
see the options; this closes reading the answer out of the FILE, which is a
different and much cheaper attack. Screen-level protection is AAC's job and
waits on the entitlement.

**Escape hatch**

If the two formats prove too costly to maintain in step, the fallback is a
single format plus a delivery-time projection function with an exhaustive test
asserting no key field survives — weaker, because it depends on the projection
being called, but recoverable. The sealed ids are independent of that choice and
would survive it.

The per-attempt ids can be disabled without a wire change: the shape already
carries opaque strings, so emitting authoring ids again is a one-line revert. It
should not be, but the option exists if the secret becomes an operational
problem before the entitlement lands.
