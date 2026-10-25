---
type: Component Overview
title: Graphing calculator and graph items (packages/graphing)
description: The @secure-test/graphing workspace package that powers three product features - the student graphing calculator, stimulus graphs and "graph it" answer items - how each crosses the design tool, the schema, and the macOS client, and which client version gates them.
tags: [graphing, calculator, package, client-version]
timestamp: 2026-10-25T00:00:00.000Z
openwiki:
  roles: [architecture, domain]
  change_kinds: [public-api, package-export, client-gate]
  source_paths: [packages/graphing/package.json, packages/graphing/src/server.ts, packages/graphing/src/page.ts, packages/schema/src/graph.ts, design-tool/lib/items/clientSupport.ts]
  symbols: [MIN_CLIENT_VERSION_FOR_TYPE, MIN_CLIENT_VERSION_FOR_FEATURE, requiredClientUpgrade, scoreGraph, GRAPH_TOOLS]
  test_paths: [design-tool/test/graph-item.test.ts, design-tool/test/calculator-api.test.ts, design-tool/test/delivery-api.test.ts, packages/graphing/test/graphAnswer.test.ts]
  invariants:
    - Graph items, the calculator and stimulus graphs need SecureTest client 2.0.0 or later; older clients are refused with 409 update required, never handed a test without them.
    - Graph answers are compared by shape with exact integer arithmetic on snapped coordinates, not by click tolerance.
  validation_commands: ["cd packages/graphing && bun test", "cd design-tool && $TESTDB bun test test/graph-item.test.ts"]
---

# Graphing calculator and graph items

`packages/graphing` (`@secure-test/graphing`, MIT, private workspace package) is the one codebase behind three student-facing features. The product decision is in `docs/graphing-calculator-design.md`: teachers asked for a Desmos-like calculator, Desmos itself needed a paid embedding contract, so the team built its own engine with its own look and no copied Desmos code or name. The design doc's status line and the `D-n` decision tags are cited in code comments and tests.

| Feature | What the student sees | Where it is configured | Canonical page |
| --- | --- | --- | --- |
| Test calculator | A Calculator button opening a movable panel: four-function, scientific or graphing mode | `assessments.calculator_mode` / `calculator_preset` | [calculator](calculator.md) |
| Stimulus graph | A teacher-authored graph shown with the question, with alt text | `items.config.graph` | [graph items](graph-items.md#stimulus-graphs) |
| Graph item | A board to place points, lines, segments, rays, circles and parabolas on | `config.graph_board`, `config.graph_key` | [graph items](graph-items.md) |

## Package surfaces

`packages/graphing/package.json` exports four entry points. Each has a different consumer, and mixing them up is a common source of breakage:

- `./server` (`src/server.ts`): no DOM and no MathLive. The design tool imports it in API routes (`lib/api/items.ts`, `studentAttempt.ts`, `reviewActions.ts`, `lib/scoring/auto.ts`) and in preview and reporting (`lib/preview/renderHtml.ts`, `lib/reporting/answerView.ts`). It exports the SVG renderers, the alt-text describer, `analyze`, and the answer engine (`canonical`, `parseSnap`, `scoreGraph`, `graphPoints`, `graphMaxPoints`, `GRAPH_TOOLS`).
- `./ui` (`src/ui/index.ts`): the browser editors and players. `GraphItemEditor.tsx` and `GraphStimulusEditor.tsx` load it with a dynamic import.
- `./mathlive` (`src/mathlive.ts`): the MathLive math-field bridge, also dynamically imported by the editors.
- `.` (`src/index.ts`): a small root barrel.

`src/page.ts` is a separate build entry. `scripts/build-page.ts` wraps it into one plain-JS function body, `graphingScript`, that the Swift client vendors as `client/SecureTestCore/Sources/SecureTestCore/GeneratedGraphing.swift`. Do not hand-edit that generated literal. The checked-in `GraphingScriptTests.swift` pins its shape: it is one dormant function with no statement outside it.

The engine is `src/engine/`. The modules that matter most are `parser.ts` and `compile.ts` (expression parsing), `interval.ts` (own interval arithmetic), `analyze.ts` and `poi.ts` (points of interest), `graphAnswer.ts` (graph-answer canonicalisation and scoring), `svg.ts`, and `describe.ts`.

## Gating: client 2.0.0

All three features are served from the client's v2.0 served renderer. `design-tool/lib/items/clientSupport.ts` encodes the floors:

- `MIN_CLIENT_VERSION_FOR_TYPE` has `graph: "2.0.0"`. A bundle that contains a graph item is refused for an older client.
- `MIN_CLIENT_VERSION_FOR_FEATURE` has `calculator` and `graph_stimulus`, both `"2.0.0"`. The delivery route (`design-tool/app/api/assessments/[id]/delivery/route.ts`) passes `calculator` when the bundle has one and `graph_stimulus` when any item carries a `graph`, so a test with either is refused for an older client.
- `requiredClientUpgrade(clientVersion, types, features)` returns the newest unmet floor, or `null`. A missing or unparseable `X-SecureTest-Version` counts as too old.

Unlike passage highlighting, the calculator is part of what the test measures, so it is refused rather than silently dropped. Highlighting is the opposite case. The contrast is documented in [passage highlighting](../design-tool/passage-highlighting.md). The refusal runs in the delivery route before lockdown begins, as described in [sittings and attempts](../design-tool/sittings-and-attempts.md).

## Runtime relationships

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label. -->
```text
flowchart LR
  Author[Teacher editors<br/>GraphItemEditor, GraphStimulusEditor] -->|config| DB[(items.config)]
  DB --> Bundle[buildDeliveryBundle<br/>board only, no key]
  Bundle -->|X-SecureTest-Version gate| Client[macOS client page<br/>graphingScript]
  Client -->|GraphResponse objects| Attempt[studentAttempt<br/>canonical + max_objects]
  Attempt --> Score[scoreGraph<br/>scoring auto]
  Score --> Review[review queue<br/>graph_lines]
```

The key never leaves the server. `buildDeliveryBundle` emits only `board` for a graph item, and the `graph_key` is read only by scoring and review. The same rule is in [wire formats](../architecture/wire-formats.md) and [scoring and results](../design-tool/scoring-and-results.md).

## Change guidance

- Start with `src/engine/graphAnswer.ts` for answer semantics. Keep comparisons on snapped integer coordinates; a change to tolerance is a scoring change.
- Adding a graph tool means touching `GRAPH_TOOLS`, `canonical` and `describeObject`, the graph wire shapes in `packages/schema/src/graph.ts`, and the UI in `src/ui/graphAnswer.ts`. Verify with `packages/graphing/test/graphAnswer.test.ts` and `graph-item.test.ts`.
- Changing the vendored page script needs `bun run build:page` in `packages/graphing`, then the Swift `GraphingScriptTests`. Do not edit `GeneratedGraphing.swift` directly.
- Any change to a floor in `clientSupport.ts` changes what old clients receive. Check the matching `delivery-api.test.ts` cases before changing it.
- Scope boundary: `packages/graphing/playground/` and `scripts/playground.ts` are developer tools, not product runtime.

Validation: `cd packages/graphing && bun test` covers the engine and UI-pure modules, and the design tool's `graph-item.test.ts`, `calculator-api.test.ts`, `delivery-api.test.ts` ("graphing calculator on the wire") and `preview-graph.test.ts` cover the server half. Expensive client checks (`swift test --filter GraphingScriptTests`) are needed only when `packages/graphing/src/page.ts`, `src/ui/`, or the generated Swift literal changes.
