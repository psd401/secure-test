// PDF-import slice 3b (2026-10-25): score one import against a hand-checked
// answer set, so a change (page images, a model) is judged on whether the
// proposal is right, not on item counts that cannot say which run was right.
// Pure; the answer set itself describes teacher documents and lives
// gitignored in samples/ (see scripts/compare-pdf-import.ts --expected).

export interface ExpectedNumber {
  /** [min, max] valid items claiming this printed number. */
  items: [number, number];
  /** Acceptable item types; [] = none expected. */
  types: string[];
  /** Figures that belong with this number (the extractor's numbering). */
  figures: number[];
}

export interface ExpectedImport {
  total_items: [number, number];
  numbers?: Record<string, ExpectedNumber>;
  /** Every item's type must be one of these (documents with no numbering). */
  types?: string[];
  /** Detected forms: how many, and how many distinct numbers each holds. */
  forms?: { count: number; sizes: number[] };
  /** Answer-key drawings: must be reported as such and be in no set. */
  key_figures?: number[];
  /** Figures that must never be shown as a stimulus. */
  never_attach?: number[];
  /** Keys that must come through on some short_text item. */
  keys_required?: { answers: string[] };
}

export interface ObservedImport {
  /** Validated candidates: type, claimed printed numbers, short-text key. */
  items: { type: string; numbers: number[]; correct_answer?: string | null }[];
  /** Proposed sets: figures and the validated item indexes they hold. */
  sets: { figures: number[]; item_indexes: number[] }[];
  key_figures: number[];
  forms: { sizes: number[] } | null;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const inRange = (n: number, [lo, hi]: [number, number]) => n >= lo && n <= hi;
const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/\\,/g, "");

export function scoreImport(expected: ExpectedImport, observed: ObservedImport): Check[] {
  const checks: Check[] = [];
  const { items, sets } = observed;

  checks.push({
    name: "total items",
    pass: inRange(items.length, expected.total_items),
    detail: `${items.length} (want ${expected.total_items.join("–")})`,
  });

  // Figures each printed number got, through the sets that hold its items.
  const figuresFor = new Map<number, Set<number>>();
  for (const set of sets) {
    for (const idx of set.item_indexes) {
      for (const n of items[idx]?.numbers ?? []) {
        const got = figuresFor.get(n) ?? new Set<number>();
        set.figures.forEach((f) => got.add(f));
        figuresFor.set(n, got);
      }
    }
  }

  for (const [key, want] of Object.entries(expected.numbers ?? {})) {
    const n = Number(key);
    const mine = items.filter((it) => it.numbers.includes(n));
    checks.push({
      name: `#${n} item count`,
      pass: inRange(mine.length, want.items),
      detail: `${mine.length} (want ${want.items.join("–")})`,
    });
    if (mine.length > 0 && want.types.length > 0) {
      const bad = mine.map((it) => it.type).filter((t) => !want.types.includes(t));
      checks.push({
        name: `#${n} types`,
        pass: bad.length === 0,
        detail: bad.length ? `unexpected ${[...new Set(bad)].join(", ")}` : undefined,
      });
    }
    if (want.items[1] > 0) {
      const got = [...(figuresFor.get(n) ?? [])];
      checks.push({
        name: `#${n} figures`,
        pass: sameSet(got, want.figures),
        detail: `[${got.sort((a, b) => a - b).join(",")}] (want [${want.figures.join(",")}])`,
      });
    }
  }

  if (expected.types) {
    const bad = items.map((it) => it.type).filter((t) => !expected.types!.includes(t));
    checks.push({ name: "types", pass: bad.length === 0, detail: bad.length ? `unexpected ${[...new Set(bad)].join(", ")}` : undefined });
  }

  if (expected.forms) {
    const sizes = observed.forms?.sizes ?? [];
    checks.push({
      name: "forms",
      pass: sizes.length === expected.forms.count && sameSet(sizes, expected.forms.sizes),
      detail: `${sizes.length} forms [${sizes.join("/")}] (want ${expected.forms.count} [${expected.forms.sizes.join("/")}])`,
    });
  }

  const attached = new Set(sets.flatMap((s) => s.figures));
  for (const f of expected.key_figures ?? []) {
    checks.push({ name: `key figure ${f} flagged`, pass: observed.key_figures.includes(f) });
  }
  for (const f of new Set([...(expected.key_figures ?? []), ...(expected.never_attach ?? [])])) {
    checks.push({ name: `figure ${f} not shown to students`, pass: !attached.has(f) });
  }

  for (const answer of expected.keys_required?.answers ?? []) {
    const hit = items.some((it) => it.type === "short_text" && it.correct_answer && norm(it.correct_answer).includes(norm(answer)));
    checks.push({ name: `key "${answer}"`, pass: hit });
  }

  return checks;
}
