import type { z } from "zod";
import { ItemBundleSchema, type ItemBundle } from "@secure-test/schema";
import { ITEM_TYPES, type ItemType } from "@/db/schema";
import { ITEM_TYPE_LABEL } from "@/lib/items/typeLabel";

/**
 * Editor redesign Phase 8 (D-5; Q3 answered: district-curated). The start
 * screen's templates: a small, checked-in set of hand-built ItemBundles. They
 * are the TEACHER wire format (ADR 0016), keys included, and a teacher who
 * picks one gets their own draft through the same import path a .json file
 * takes (`importBundleForOwner`), so a template can never hold something an
 * import could not.
 *
 * Content rule (public repo, CLAUDE.md): every question and passage here is
 * written for this file. Nothing is quoted from a real teacher's assessment,
 * and nothing names a student, a school or a person.
 *
 * Adding a template: add an entry below. test/start-screen.test.ts checks that
 * every entry parses with ItemBundleSchema, creates through the import, saves
 * back through the item PATCH validator unchanged, and has no gap in the
 * "Before publishing" list.
 */
type ItemBundleInput = z.input<typeof ItemBundleSchema>;

export interface AssessmentTemplate {
  /** Stable id the start screen posts back. Never shown. */
  id: string;
  /** The template's name, and the new draft's name (the import's copy rule applies). */
  title: string;
  /** One line under the name on the start screen. */
  summary: string;
  bundle: ItemBundleInput;
}

export const ASSESSMENT_TEMPLATES: readonly AssessmentTemplate[] = [
  {
    id: "exit-ticket",
    title: "Exit ticket",
    summary: "Three quick questions to end a lesson: one choice, one short answer, one written reflection.",
    bundle: {
      test_id: "template-exit-ticket",
      title: "Exit ticket",
      items: [
        {
          id: "q1",
          type: "multiple_choice_single",
          stem: "Which fraction is equal to $\\frac{1}{2}$?",
          choices: [
            { id: "a", text: "$\\frac{2}{4}$" },
            { id: "b", text: "$\\frac{1}{3}$" },
            { id: "c", text: "$\\frac{2}{3}$" },
            { id: "d", text: "$\\frac{3}{4}$" },
          ],
          correct_choice_id: "a",
        },
        {
          id: "q2",
          type: "short_text",
          stem: "What is $3 \\times 4$?",
          correct_answer: "12",
        },
        {
          id: "q3",
          type: "essay",
          stem: "Write **one** thing you learned today and **one** question you still have.",
          max_word_count: 100,
        },
      ],
    },
  },
  {
    id: "reading-check",
    title: "Reading check with a passage",
    summary: "A short passage with three questions about it. Students can highlight the passage.",
    bundle: {
      test_id: "template-reading-check",
      title: "Reading check with a passage",
      allow_highlighting: true,
      items: [
        {
          id: "q1",
          type: "multiple_choice_single",
          stem: "What is the passage **mostly** about?",
          choices: [
            { id: "a", text: "How neighbors turned an empty lot into a garden" },
            { id: "b", text: "Why tomatoes need full sun" },
            { id: "c", text: "How to build a fence" },
            { id: "d", text: "Where the city keeps its tools" },
          ],
          correct_choice_id: "a",
        },
        {
          id: "q2",
          type: "multiple_choice_multi",
          stem: "Which **two** details show that the garden helped the neighborhood?",
          choices: [
            { id: "a", text: "Neighbors who had never spoken now shared tools." },
            { id: "b", text: "The lot had been empty for years." },
            { id: "c", text: "Extra vegetables went to the food bank." },
            { id: "d", text: "The first spring was rainy." },
          ],
          correct_choice_ids: ["a", "c"],
        },
        {
          id: "q3",
          type: "essay",
          stem: "Would you want a garden like this where you live? Use one detail from the passage to explain.",
          max_word_count: 150,
        },
      ],
      item_sets: [
        {
          id: "passage",
          stimulus:
            "**The Corner Lot**\n\n" +
            "For years the lot on the corner held nothing but weeds and a broken fence. " +
            "One spring, a few neighbors asked the city if they could plant something there. " +
            "They pulled weeds, built raised beds and took turns watering.\n\n" +
            "By the end of summer the beds were full of beans, squash and tomatoes. " +
            "Neighbors who had never spoken now shared tools and swapped recipes. " +
            "When the gardeners grew more than they could eat, they took the extra vegetables to the food bank.",
          item_ids: ["q1", "q2", "q3"],
        },
      ],
    },
  },
  {
    id: "vocabulary-sequence",
    title: "Vocabulary and sequence practice",
    summary: "Match words to meanings, put steps in order, and fill in a blank.",
    bundle: {
      test_id: "template-vocabulary-sequence",
      title: "Vocabulary and sequence practice",
      items: [
        {
          id: "q1",
          type: "match",
          stem: "Match each word to its meaning.",
          pairs: [
            { id: "p1", left: "Evaporation", right: "Liquid water turns into vapor" },
            { id: "p2", left: "Condensation", right: "Vapor cools into tiny drops" },
            { id: "p3", left: "Precipitation", right: "Water falls as rain or snow" },
            { id: "p4", left: "Collection", right: "Water gathers in rivers, lakes and oceans" },
          ],
        },
        {
          id: "q2",
          type: "order",
          stem: "Put the steps of the water cycle in order, starting with water in the ocean.",
          sequence: [
            { id: "s1", label: "The sun warms the water and it evaporates." },
            { id: "s2", label: "The vapor cools and forms clouds." },
            { id: "s3", label: "Rain falls from the clouds." },
            { id: "s4", label: "The rain flows back to the ocean." },
          ],
        },
        {
          id: "q3",
          type: "fill_blank",
          stem: "When a puddle dries up on a sunny day, the water has gone through [[b1]].",
          blanks: [{ id: "b1", kind: "text", keys: ["evaporation"] }],
        },
      ],
    },
  },
];

export function templateById(id: string): AssessmentTemplate | null {
  return ASSESSMENT_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The template as the import reads it. Throws if a template stopped parsing (the test pins that none does). */
export function templateBundle(t: AssessmentTemplate): ItemBundle {
  return ItemBundleSchema.parse(t.bundle);
}

/** "What's in it" for the start screen: question counts by type, in ITEM_TYPES order. */
export function templateTypeCounts(t: AssessmentTemplate): { type: ItemType; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of templateBundle(t).items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
  return ITEM_TYPES.filter((ty) => counts.has(ty)).map((ty) => ({ type: ty, count: counts.get(ty)! }));
}

/**
 * Blank-with-example (D-5): the one question a blank draft can start with, so
 * the editor never opens on an empty page. It goes in through the import's
 * own row builder (`planImport`), like a template's questions. Its text says
 * it is an example, so a teacher who leaves it in sees why it is there.
 */
export const EXAMPLE_QUESTION_BUNDLE: ItemBundleInput = {
  test_id: "example-question",
  title: "Example",
  items: [
    {
      id: "example",
      type: "multiple_choice_single",
      stem:
        "Example question: which planet is closest to the Sun? " +
        "(Change this text to write your own question, or delete it.)",
      choices: [
        { id: "a", text: "Mercury" },
        { id: "b", text: "Venus" },
        { id: "c", text: "Earth" },
        { id: "d", text: "Mars" },
      ],
      correct_choice_id: "a",
    },
  ],
};

/** The start screen's one-line "what's in it", e.g. "1 Multiple choice · 1 Short answer · 1 passage". */
export function templateContents(t: AssessmentTemplate): string {
  const parts = templateTypeCounts(t).map((c) => `${c.count} ${ITEM_TYPE_LABEL[c.type]}`);
  const sets = t.bundle.item_sets?.length ?? 0;
  if (sets > 0) parts.push(`${sets} passage${sets === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The templates as the start screen lists them (no bundle: the client gets names and counts only). */
export function startTemplates(): { id: string; title: string; summary: string; contents: string }[] {
  return ASSESSMENT_TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    contents: templateContents(t),
  }));
}
