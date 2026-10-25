---
type: Domain Concept
title: Graph items and stimulus graphs - board, key, student objects and scoring
description: The "graph it" item type (a snapped board the student places points, lines, circles and parabolas on), its shape-based auto-scoring with all and per_object modes, the stimulus graph attached to any item, and how each flows through authoring, export, delivery, scoring, review and preview.
tags: [graph-item, stimulus-graph, scoring, graphing]
timestamp: 2026-10-25T00:00:00.000Z
openwiki:
  roles: [domain, integration]
  change_kinds: [item-type, scoring, wire-format]
  source_paths: [packages/schema/src/graph.ts, packages/schema/src/items.ts, packages/graphing/src/engine/graphAnswer.ts, design-tool/lib/api/items.ts, design-tool/lib/api/buildDeliveryBundle.ts, design-tool/lib/api/studentAttempt.ts, design-tool/lib/scoring/auto.ts, design-tool/lib/api/reviewActions.ts, design-tool/lib/api/importBundle.ts]
  symbols: [GraphBoardSchema, GraphKeySchema, GraphResponseSchema, StimulusGraphSchema, scoreGraph, canonical, parseSnap, graphIssues, graphMaxPoints, graphAnswerLines]
  test_paths: [design-tool/test/graph-item.test.ts, design-tool/test/calculator-api.test.ts, design-tool/test/import-api.test.ts, design-tool/test/review-queue.test.ts, design-tool/test/preview-graph.test.ts, packages/graphing/test/graphAnswer.test.ts]
  invariants:
    - A graph item needs a board; a key is optional, and a graph item without a key is hand-scored (scoring_method human), while one with a key is auto-scored.
    - The student's objects may not exceed board.max_objects, and every tool must be one the board offers; anything else is rejected at write time.
    - A response is matched by canonical shape on snapped coordinates, so two lines through different point pairs on the same line are the same answer.
    - graph_key is an answer key, so it may change on a published test; graph_board is locked.
    - The delivery bundle carries board for a graph item and never the key.
  validation_commands: ["cd packages/graphing && bun test test/graphAnswer.test.ts", "cd design-tool && $TESTDB bun test test/graph-item.test.ts"]
---

# Graph items and stimulus graphs

Two shapes of graph reach a student. A **graph item** is a question whose answer is a set of objects placed on a board. A **stimulus graph** is a teacher-authored picture attached to any item as context. Both are defined in `packages/schema/src/graph.ts` and their engine is in `packages/graphing`. The package and its client gate are in [graphing overview](overview.md).

## Graph item

The item config holds `graph_board` and optionally `graph_key`. The schemas are `GraphBoardSchema` (`x`, `y`, `grid`, `snap`, `tools`, `max_objects`, optional `fixed` objects shown but not scored), `GraphKeySchema` (`objects` plus `scoring`) and `GraphResponseSchema` (`objects`).

- **Snap.** Every point is a whole multiple of the board's snap, parsed by `parseSnap` (`"1"`, `"1/2"`, `"0.5"`). Coordinates become integers in snap units, so comparisons are exact.
- **Canonical shape.** `canonical(object, board)` turns a placed object into a key string, for example `Q x,y,num/den` for a parabola. Two different click sequences that give the same line produce the same key.
- **Scoring modes.** `scoreGraph` in `packages/graphing/src/engine/graphAnswer.ts` implements both:
  - `all`: full credit only when every key shape is present and the response has no extra shape.
  - `per_object`: the share of key shapes present. The score is zero when the response has more distinct shapes than the key, so drawing everything earns nothing. Repeats count once, and an object whose tool the board does not offer does not count.
- **Scoring method.** `items.ts` makes a graph item `auto` when it has a key and `human` otherwise. `design-tool/lib/scoring/auto.ts` calls `graphPoints` and `graphMaxPoints` from the graphing server surface.

### Flow

```mermaid
sequenceDiagram
  participant T as Teacher (item editor)
  participant A as items API
  participant D as delivery bundle
  participant C as client page
  participant R as studentAttempt / auto score
  T->>A: board + optional key (graphIssues checks both)
  A->>D: buildDeliveryBundle emits board only
  D->>C: graph item (no key)
  C->>R: GraphResponse objects
  R->>R: max_objects, tools, canonical check
  R->>R: scoreGraph(board, key, response)
```

### Write-time checks

`graphIssues(board, key)` in `design-tool/lib/api/items.ts` runs on create, PATCH and import. The import path (`design-tool/lib/api/importBundle.ts`, "F19") uses the same check, and a failure is reported as `schema_invalid:items.N.key...` with the question number. `studentAttempt.ts` rejects a response that is over `max_objects`, uses a tool the board does not offer, or has an invalid shape. A response that fails these checks is rejected at write time (the forged-or-stale write rule).

### Review and export

- The review queue (`design-tool/lib/api/reviewActions.ts`, `review-queue` route) shows a graph answer as `graph_lines` built by `graphAnswerLines`. The `review-queue.test.ts` suite "graph answers in the queue" pins the output.
- The teacher export (`design-tool/lib/api/exportBundle.ts`) writes `board`, and `key` only when one exists. The importer stores what it reads.
- Changing a key on a published test is allowed, because `isAnswerKeyOnlyPatch` in `requireDraft.ts` treats `graph_key` like other answer keys. A change to `graph_board` is locked. Auto-scoring re-runs only for unscored responses, and the rescore dialog counts a graph key edit as a change (`rescore-dialog.test.ts`).

## Stimulus graphs

`StimulusGraphSchema` attaches a `graph` (rows of LaTeX, a `view` window and required `alt` text) to any item. It is content, so it reaches the student in the delivery bundle, and the server rejects a `view` whose `xmin` is not below `xmax` (`calculator-api.test.ts`, "stimulus graphs"). The design tool renders the picture with `renderGraphSvg` in the no-script preview and print path (`design-tool/lib/preview/renderHtml.ts`, tested by `preview-graph.test.ts`). Its `graph_stimulus` client floor is 2.0.0 ([graphing overview](overview.md#gating-client-200)). Stimulus text and passages are a separate concept, described in [stimulus and item sets](../design-tool/stimulus-and-item-sets.md).

## Change guidance

- Any change to canonical shapes or tolerance changes scores for existing responses. Check `packages/graphing/test/graphAnswer.test.ts` and `design-tool/test/graph-item.test.ts` (its scoring cases) before changing them.
- Adding a tool touches `GRAPH_TOOLS`, `canonical`, `describeObject`, the schema shapes, and the client UI. Also update `importBundle` tests in `import-api.test.ts` ("import: graph items (D-9)").
- Keep the key out of anything student-facing. `buildDeliveryBundle` reads only `board`; a regression would show in `delivery-api.test.ts` ("graphing calculator on the wire").
- Scope: the graphing engine's `analyze`, `poi`, and `implicit` modules serve the calculator and stimulus rendering, not graph-item scoring. Do not expect a graph-item change to need them.

Validation: start with `cd packages/graphing && bun test test/graphAnswer.test.ts`. Use `cd design-tool && $TESTDB bun test test/graph-item.test.ts` for the server half. Run `import-api.test.ts` and `review-queue.test.ts` only when the import or queue shape changes.
