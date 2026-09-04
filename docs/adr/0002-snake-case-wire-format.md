# 0002. Keep snake_case keys in the shared wire format

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

PoC-B's Swift `ItemModel` already uses `CodingKeys` to map between Swift's camelCase (`testId`, `correctChoiceId`) and the on-wire JSON's snake_case (`test_id`, `correct_choice_id`). The bundled `items.json` fixture ships with snake_case keys. As the shared Zod schema lands in `@secure-test/schema`, the TypeScript side faces a choice:

- (A) Have Zod parse snake_case JSON and `.transform()` to camelCase TypeScript types. Idiomatic JS, but creates two key namings to keep in sync.
- (B) Keep snake_case end-to-end in TypeScript too — Zod schemas, inferred types, and any UI that touches the raw shape all use snake_case identifiers.

## Decision

Option B. Snake_case is the canonical wire format and the canonical TypeScript field name. No transforms.

## Consequences

- **Better**: zero risk of double-mapping bugs; PoC-B's `items.json` parses without any preprocessing in TS; the Swift `CodingKeys` mapping remains the only translation layer in the system, and it already exists and is tested.
- **Worse**: TypeScript code accesses `bundle.test_id` and `item.correct_choice_id`, which is mildly non-idiomatic. Linters that prefer camelCase identifiers need to allowlist these schema-derived fields.
- **Escape hatch**: if camelCase becomes important inside the UI later (e.g., a form library that doesn't handle snake_case), wrap the schema with a thin `.transform()` at the boundary — the wire format stays snake_case regardless.
