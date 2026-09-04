# @secure-test/schema

Zod source-of-truth for the assessment / item shape consumed by the secure-test macOS browser and (forthcoming) the design tool web app.

## What it exports

- `ItemBundleSchema`, `ItemSchema`, `ChoiceSchema` — Zod schemas.
- `ItemBundle`, `Item`, `Choice` — inferred TypeScript types.

## Wire format

Keys are **snake_case**, matching PoC-B's existing on-wire JSON (`test_id`, `correct_choice_id`, etc.) and its Swift `CodingKeys` mapping. TypeScript consumers read the same snake_case fields — no camelCase transform.

## Consume from another workspace package

```ts
import { ItemBundleSchema, type ItemBundle } from "@secure-test/schema";

const bundle: ItemBundle = ItemBundleSchema.parse(rawJson);
```

## Scope (Phase 1 / MVP)

Currently only the single-select multiple-choice subset that PoC-B already ships. Multi-select, short-text, long-text, rubric, image, and math blocks land in Phase 2 / 3 alongside the design-tool item editor — additions to this package should be driven by a real UI consumer, not added speculatively.

## Scripts

- `bun run build` — `tsc` → `dist/`.
- `bun test` — round-trip against PoC-B's live `items.json` plus rejection cases.

## Round-trip guarantee

The test suite parses `poc-b-test-loop/client/Sources/PocBClient/Resources/items.json` **in place** (no copy), so any drift between this schema and the PoC-B fixture surfaces as a failing test.
