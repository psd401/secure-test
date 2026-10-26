# @secure-test/markup

The authored-text markup grammar as a parser and a serializer (R-2 of
`docs/editor-redesign-design.md`). The stored format stays the markup
string (R-1); this package reads and writes it, so the new editor can
work on a tree without ever changing what is stored.

```ts
import { parse, serialize, renderedForm } from "@secure-test/markup";

const nodes = parse("Solve **for** $x^2$", {});
serialize(nodes); // "Solve **for** $x^2$" — always the input, byte for byte
```

## The grammar

Exactly what `design-tool/lib/items/renderItemContent.ts` renders today
(ADR 0009 / 0010, E6, FB slice 1), in its order:

1. `![alt](asset:<uuid>)` pictures (case-insensitive) are split out first.
2. `$…$` / `$$…$$` math; `\$` is a literal dollar; a `$` before a digit
   opens math only when its run carries `\`+letter, `^` or `_` (the money
   rule, C-2 / M-1); an unmatched `$` is text.
3. `**bold**` first, `_italic_` inside and between bolds, by the word-
   boundary rules of E6. No escape syntax: `5**2 and 3**4` is bold.
4. `[[id]]` blanks only with `parse(s, { blanks: true })` (or a list of the
   item's blank ids), for a fill-in-the-blank stem; a blank may sit inside
   bold or italic. A marker that would land inside a formula or an alt
   text makes the stem parse segment by segment, as the server does.

Node types: `text`, `escape` (`\$`), `math`, `image`, `strong`, `em`,
`blank`. Every node keeps what the source spelled, so `serialize` is a
plain concatenation and `serialize(parse(s)) === s` for every string.

`renderedForm(nodes, { resolves })` is what a student sees, as a small
comparable tree (escapes folded into text, pictures resolved or missing).
The golden fixtures are written in it.

## Known limits

- A blank-mode stem that already contains U+E000 keeps it; the server
  strips that character from a fill-in-the-blank stem before rendering.
- Where a blank marker sits inside a formula or an alt text, the two
  renderers disagree with each other (findings ER-F1 to ER-F3 in the
  design note); the parser follows the server's general rule.

## Tests

- `bun test` — the golden fixtures (`test/fixtures/golden.json`), the
  canonical spelling of each construct, and `serialize(parse(s)) === s`
  over 5,000 random strings in both modes.
- `bun run typecheck`.
- `design-tool/test/markup-golden.test.ts` runs the same fixtures against
  the server renderer (byte for byte) and the client's bridge-mode
  `renderer.js` in the client harness's DOM shim, plus a differential
  pass over random markup (`MARKUP_FUZZ=<n>` for a longer one).
