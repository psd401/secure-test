import { planTypes } from "./itemBatchCore";
import type { ClassInsightsPackInput } from "@/lib/insights/report";
import type { ClassInsightsChatInput } from "@/lib/insights/chat";
import type {
  BatchGenerateInput,
  BatchGenerableItemType,
  GenerateItemRequest,
  GenerateItemResult,
  ItemGeneratorProvider,
  SuggestStandardsInput,
} from "./types";

// Deterministic-ish provider that produces a valid, vaguely-sensible item
// derived from the prompt. Used as the default until a real model is
// wired in (see ADR 0007). Exists so:
//   - the editor UI flow can be exercised end-to-end without an API key
//   - tests can assert the route + UI contract without network calls
//   - swapping in a real provider becomes a one-file change

function pickStem(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return "AI-drafted question";
  }
  // Echo the prompt as the stem so reviewing teachers can immediately see
  // what they asked for. Capped so the stem stays readable.
  const cap = 240;
  return trimmed.length > cap ? trimmed.slice(0, cap - 1) + "…" : trimmed;
}

export const mockProvider: ItemGeneratorProvider = {
  id: "mock",

  async generateItem(req: GenerateItemRequest): Promise<GenerateItemResult> {
    const stem = pickStem(req.prompt);

    if (req.item_type === "short_text") {
      return {
        type: "short_text",
        stem,
        choices: [],
        correct_choice_ids: [],
        // Best-effort: pull a short word from the prompt as a placeholder.
        correct_answer:
          req.prompt
            .split(/\s+/)
            .find((w) => /^[A-Za-z][A-Za-z'-]{1,30}$/.test(w))
            ?.replace(/[^A-Za-z'-]/g, "") ?? "answer",
      };
    }

    const choices = [
      { id: "a", text: "Option A — drafted by AI; review before saving." },
      { id: "b", text: "Option B — drafted by AI; review before saving." },
      { id: "c", text: "Option C — drafted by AI; review before saving." },
      { id: "d", text: "Option D — drafted by AI; review before saving." },
    ];

    if (req.item_type === "multiple_choice_single") {
      return {
        type: "multiple_choice_single",
        stem,
        choices,
        correct_choice_ids: ["a"],
        correct_answer: null,
      };
    }

    return {
      type: "multiple_choice_multi",
      stem,
      choices,
      correct_choice_ids: ["a", "b"],
      correct_answer: null,
    };
  },

  // BG slice 3: deterministic proposals honoring count + types. The stem names
  // the batch's focus (objective, else the standards, else the resource) so a
  // reviewer sees what was asked for. Two test hooks in `notes`, like the
  // rubric mock's markers: MOCK_MALFORMED breaks the first element,
  // MOCK_ALL_MALFORMED breaks every one.
  async generateItems(input: BatchGenerateInput): Promise<unknown[]> {
    const focus =
      input.objective ??
      (input.standards.length > 0
        ? input.standards.map((s) => s.code).join(", ")
        : input.resource
          ? "the source material"
          : "the teacher's notes");
    const notes = input.notes ?? "";
    const all = notes.includes("MOCK_ALL_MALFORMED");
    const first = notes.includes("MOCK_MALFORMED");
    return planTypes(input.count, input.types).map((type, i) => {
      if (all || (first && i === 0)) return { type, stem: "" };
      return mockBatchItem(type, `Question ${i + 1} on ${focus}`);
    });
  },

  // BG slice 5: deterministic suggestions — two catalog candidates per item,
  // rotating through the list, with a reason that echoes the stem's opening
  // (so a stem the mock guardrail blocks blocks the output stage). Two hooks
  // in the pasted unit list: MOCK_MALFORMED returns a reply that is not a
  // JSON array (→ 502), MOCK_OUT_OF_CATALOG adds a code the catalog does not
  // have to every item (→ dropped by validation).
  async suggestStandards(input: SuggestStandardsInput): Promise<unknown[]> {
    const list = input.unitList ?? "";
    if (list.includes("MOCK_MALFORMED")) throw new Error("mock_returned_invalid_json");
    const outside = list.includes("MOCK_OUT_OF_CATALOG");
    const n = input.candidates.length;
    return input.items.map((item, i) => {
      const tags: { code: string; reason: string }[] = [];
      for (let k = 0; k < Math.min(2, n); k++) {
        tags.push({
          code: input.candidates[(i + k) % n]!.code,
          reason: `Mock: the question "${item.stem.slice(0, 40)}" fits this standard.`,
        });
      }
      if (outside) tags.push({ code: "NOT.A.REAL.CODE", reason: "Mock: out of catalog." });
      return { item: item.ref, tags };
    });
  },

  async generateClassInsights(pack: ClassInsightsPackInput): Promise<unknown> {
    return mockClassInsights(pack);
  },

  async classInsightsChat(input: ClassInsightsChatInput): Promise<unknown> {
    return mockClassInsightsChat(input);
  },
};

// Class insights slice 4: a deterministic chat reply from the pack's real
// keys, so it survives the fill. Hooks in the teacher's MESSAGE:
// MOCK_MALFORMED throws as an unparseable reply would (→ 502); MOCK_INVENTED
// writes a digit of its own (→ refused, 502); MOCK_BLOCK_REPLY puts the mock
// guardrail's sentinel in the reply (→ output block; the message itself does
// not trip the input check).
export function mockClassInsightsChat(input: ClassInsightsChatInput): unknown {
  const { pack, message } = input;
  if (message.includes("MOCK_MALFORMED")) throw new Error("mock_returned_invalid_json");
  if (message.includes("MOCK_INVENTED")) return { text: "Seven students missed it: 7 of them." };
  if (message.includes("MOCK_BLOCK_REPLY")) return { text: "Mock: BLOCKME" };

  const labels = new Set(pack.assessment.items.map((i) => i.label));
  const q = [...message.matchAll(/\bQ(\d+)\b/g)].map((m) => `Q${m[1]}`).find((l) => labels.has(l));
  const studentIds = new Set(pack.students.map((s) => s.id));
  const s = [...message.matchAll(/\bS(\d+)\b/g)].map((m) => `S${m[1]}`).find((l) => studentIds.has(l));

  const parts: string[] = [];
  const figures: string[] = [];
  if (q && pack.figures[`item.${q}.p_value`] !== undefined) {
    parts.push(`On ${q} the class averaged {item.${q}.p_value} of the points.`);
    figures.push(`item.${q}.p_value`);
  } else if (q) {
    parts.push(`There are no scored results for ${q} yet.`);
  }
  if (s) {
    parts.push(`${s} earned {student.${s}.total} of {student.${s}.max} points.`);
    figures.push(`student.${s}.total`, `student.${s}.max`);
  }
  const readers = [...new Set(input.answers.map((a) => a.student))];
  if (readers.length > 0) parts.push(`I read the answers from ${readers.join(" and ")}.`);
  if (parts.length === 0) parts.push("The evidence pack cannot answer that; ask about a question or a student.");
  return {
    text: parts.join("\n"),
    citations: { items: q ? [q] : [], students: [...new Set([...(s ? [s] : []), ...readers])] },
    figures,
  };
}

// Class insights slice 2: a deterministic report built ONLY from keys the pack
// actually has, so it always survives `fillReport`. Three hooks in the
// assessment title, like the other mocks' markers: MOCK_MALFORMED throws as
// an unparseable reply would (→ 502); MOCK_INVENTED adds three claims that
// must drop (a digit of its own, an unknown figure key, an unknown student);
// BLOCKME puts the mock guardrail's sentinel in a claim (→ output block).
export function mockClassInsights(pack: ClassInsightsPackInput): unknown {
  const title = pack.assessment.title;
  if (title.includes("MOCK_MALFORMED")) throw new Error("mock_returned_invalid_json");

  const scored = pack.item_analytics.filter((a) => a.p_value !== null);
  const best = [...scored].sort((a, b) => b.p_value! - a.p_value! || a.label.localeCompare(b.label))[0];
  const worst = [...scored].sort((a, b) => a.p_value! - b.p_value! || a.label.localeCompare(b.label))[0];
  const strugglers = worst
    ? pack.students
        .filter((s) => pack.figures[`student.${s.id}.item.${worst.label}.points`] !== undefined)
        .sort(
          (a, b) =>
            pack.figures[`student.${a.id}.item.${worst.label}.points`]! -
              pack.figures[`student.${b.id}.item.${worst.label}.points`]! || a.id.localeCompare(b.id),
        )
        .slice(0, 2)
        .map((s) => s.id)
    : [];
  const top = [...pack.students].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))[0];

  const strengths: unknown[] = [];
  if (best) {
    strengths.push({
      text: `The class did well on ${best.label}, averaging {item.${best.label}.p_value} of its points.`,
      citations: { items: [best.label] },
    });
  }
  const tag = [...pack.tags].sort((a, b) => b.percent - a.percent || a.tag.localeCompare(b.tag))[0];
  if (tag) {
    strengths.push({
      text: `Questions tagged ${tag.code} came out at {tag.${tag.tag}.percent} overall.`,
      citations: { tags: [tag.code] },
    });
  }
  if (pack.scope.note) {
    strengths.push({
      text: "Some responses are not scored yet ({scope.unscored_responses}), so this picture is partial.",
    });
  }
  if (title.includes("BLOCKME")) strengths.push({ text: "Mock: BLOCKME" });

  const growth: unknown[] = [];
  if (worst) {
    const wrong = (worst.choice_counts ?? [])
      .filter((c) => !c.is_key && c.count > 0)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
    growth.push({
      text:
        `${worst.label} was the hardest question at {item.${worst.label}.p_value}` +
        (wrong
          ? `; choice ${wrong.label} drew {item.${worst.label}.choice.${wrong.label}.count} answers, which suggests a shared misconception.`
          : ".") +
        (strugglers.length > 0 ? ` See ${strugglers.join(" and ")}.` : ""),
      citations: { items: [worst.label], students: strugglers },
    });
  }

  const celebrations: unknown[] = top
    ? [
        {
          text: `${top.id} earned {student.${top.id}.total} of {student.${top.id}.max} points.`,
          citations: { students: [top.id] },
        },
      ]
    : [];

  const focus = worst?.label;
  const next_steps: unknown[] = [
    {
      text: focus
        ? `Reteach the idea behind ${focus} with a short worked example before moving on.`
        : "Open the next lesson with a short check on the unit's key idea.",
      ...(focus ? { citations: { items: [focus] } } : {}),
    },
    strugglers.length > 0 && focus
      ? {
          text: `Pull a small group (${strugglers.join(", ")}) to revisit ${focus}.`,
          citations: { items: [focus], students: strugglers },
        }
      : { text: "Close with an exit ticket on the same idea to see who has it now." },
  ];

  if (title.includes("MOCK_INVENTED")) {
    strengths.push({ text: "Seven students aced it: 7 of them." });
    growth.push({ text: "Look at {item.Q99.p_value}.", citations: { items: ["Q1"] } });
    celebrations.push({ text: "S999 did great on Q1.", citations: { students: ["S999"], items: ["Q1"] } });
  }

  return { strengths, growth, celebrations, next_steps };
}

function mockBatchItem(type: BatchGenerableItemType, stem: string): GenerateItemResult {
  const choices = ["a", "b", "c", "d"].map((id) => ({
    id,
    text: `Option ${id.toUpperCase()} — drafted by AI; review before saving.`,
  }));
  if (type === "multiple_choice_single") {
    return { type, stem, choices, correct_choice_ids: ["a"], correct_answer: null };
  }
  if (type === "multiple_choice_multi") {
    return { type, stem, choices, correct_choice_ids: ["a", "b"], correct_answer: null };
  }
  if (type === "short_text") {
    return { type, stem, choices: [], correct_choice_ids: [], correct_answer: "answer" };
  }
  if (type === "match") {
    // BG slice 6: three distinct pairs; no ids — the server numbers them, as
    // it does for the model's reply.
    return {
      type,
      stem: `${stem}: match each term to its partner.`,
      pairs: [1, 2, 3].map((n) => ({ left: `Term ${n}`, right: `Partner ${n} — drafted by AI` })),
    } as unknown as GenerateItemResult;
  }
  if (type === "fill_blank") {
    // FB slice 4: one dropdown and one typed blank, options and keys as text
    // with no option ids — the server numbers them, as it does for the model.
    return {
      type,
      stem: `${stem}: the [[b1]] word and the [[b2]] word.`,
      blanks: [
        { id: "b1", kind: "dropdown", options: ["first", "second", "third"], correct_option: "first" },
        { id: "b2", kind: "text", keys: ["answer"] },
      ],
    } as unknown as GenerateItemResult;
  }
  return { type, stem, choices: [], correct_choice_ids: [], correct_answer: null };
}
