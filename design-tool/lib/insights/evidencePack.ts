// Class insights slice 1 (docs/class-insights-design.md, D-1 / D-2 / D-6 /
// D-7): the evidence pack — the ONLY thing the report and chat models will
// see — and the pseudonym map the server keeps to swap names back in.
//
// Two halves, deliberately:
//   - `buildEvidencePackFromData` is PURE: plain objects in, `{ pack, names }`
//     out. Every exclusion rule lives here, so the tests can prove them with
//     hand-built data and no database.
//   - `buildEvidencePack` is the loader: `buildResults` for the scoping it
//     already gets right (owner-scoped students, practice excluded, section
//     labels), one read of the scoped responses with their FINAL score, and
//     the open safeguarding alerts. Analytics go through R1's
//     `buildItemAnalytics` rather than a second aggregation.
//
// What never enters `pack`: student names, emails, student numbers, SSIDs,
// attempt / response / item ids, and any student-written text except the
// anonymous short-text answer clusters and, for fill-in-the-blank, the
// anonymous per-blank answer counts (and from both, every answer whose
// response carries an OPEN safeguarding alert). `names` is the server's half
// and is never sent to a model.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FillBlankBlank, Rubric } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { assessments, items, responses, safeguarding_alerts, scores } from "@/db/schema";
import { buildItemAnalytics } from "@/lib/reporting/analytics";
import { overallRationale, rubricScoreRows } from "@/lib/reporting/rubricScoreView";
import { buildResults, itemMaxPoints } from "@/lib/scoring/results";
import { lookupTags } from "@/lib/standards/search";
import { chipLabel, shortText } from "@/lib/standards/tags";
import { fillBlankAnswer } from "@/lib/items/fillBlankAnswer";

export const STEM_MAX = 200;
export const RATIONALE_MAX = 400;
export const TOP_ANSWERS = 8;

/** The results page's `?section=` value for "rows with no section resolved". */
export const NO_SECTION_FILTER = "__none__";

const MC_TYPES = new Set(["multiple_choice_single", "multiple_choice_multi"]);

// ---------------------------------------------------------------------------
// Input (plain objects)

export interface EvidenceItemInput {
  id: string;
  position: number;
  type: string;
  stem: string;
  max_points: number;
  standards: string[];
  choices?: Array<{ id: string; text: string }>;
  correct_choice_ids?: string[];
  /** short_text's key — teacher content, shown to the model as the key. */
  correct_answer?: string | null;
  rubric?: Rubric | null;
  /** FB slice 3: a fill_blank's blanks — teacher content, keys included. */
  blanks?: FillBlankBlank[] | null;
}

export interface EvidenceAttemptInput {
  attempt_id: string;
  status: "submitted" | "in_progress";
  /** Only ever copied into `names`. */
  display_name: string;
  /** Carried so a caller can pass a results row as-is; never read. */
  student_number?: string | null;
  email?: string | null;
  ssid?: string | null;
}

export interface EvidenceResponseInput {
  response_id: string;
  attempt_id: string;
  item_id: string;
  response: Record<string, unknown> | null;
  /** The FINAL score row, or null (unscored, or an AI proposal only). */
  final: { points: number; max_points: number; rationale: unknown } | null;
}

export interface EvidencePackInput {
  assessment: { title: string; items: EvidenceItemInput[] };
  /** null = all sections; NO_SECTION_FILTER = "no section"; else the label. */
  section: string | null;
  attempts: EvidenceAttemptInput[];
  responses: EvidenceResponseInput[];
  /** Response ids with at least one unacknowledged safeguarding alert. */
  open_alert_response_ids: ReadonlySet<string>;
  /** `lookupTags` output; a tag missing here shows as stored. */
  tag_lookup?: Record<string, { code: string; text: string } | null>;
}

// ---------------------------------------------------------------------------
// Output

export interface PackItem {
  label: string;
  type: string;
  max_points: number;
  stem: string;
  tags: Array<{ tag: string; code: string; text: string | null }>;
  /** MC only: choices lettered A, B, … in stored order, the key marked. */
  choices?: Array<{ label: string; text: string; is_key: boolean }>;
  /** short_text only. */
  key?: string;
  /**
   * FB slice 3, fill_blank only: each blank in stem order ("Blank n", as the
   * stem's `[Blank n]` gaps), a dropdown's options and every key as text.
   */
  blanks?: Array<{ label: string; kind: "dropdown" | "text"; options?: string[]; keys?: string[] }>;
}

export interface PackItemAnalytics {
  label: string;
  answered_count: number;
  answered_percent: number | null;
  scored_count: number;
  unscored_count: number;
  mean: number | null;
  p_value: number | null;
  choice_counts?: Array<{ label: string; count: number; is_key: boolean }>;
  /** short_text: the top distinct answers, alert-flagged ones excluded. */
  answers?: Array<{ answer: string; count: number; mean_points: number | null }>;
  /**
   * FB slice 3, fill_blank only: per blank, how many answered it, how many
   * matched the key (null when unkeyed), and the top answers — anonymous,
   * alert-flagged ones excluded, like short_text's.
   */
  blank_answers?: Array<{
    blank: string;
    answered_count: number;
    right_count: number | null;
    answers: Array<{ answer: string; count: number; right: boolean | null }>;
  }>;
  /** Rubric items: per criterion, how many final scores landed on each level. */
  criteria?: Array<{ criterion: string; levels: Array<{ level: string; count: number }> }>;
}

export interface PackStudent {
  id: string;
  total: number;
  max: number;
  unscored: number;
  items: Array<{ label: string; points: number | null; max_points: number }>;
  tags: Array<{ tag: string; percent: number }>;
  essays: Array<{
    label: string;
    criteria: Array<{ criterion: string; level: string; points: number }>;
    rationale: string | null;
  }>;
}

export interface EvidencePack {
  scope: {
    section: string;
    handed_in: number;
    /** Handed-in attempts with every answered question carrying a final score. */
    scored: number;
    unscored_responses: number;
    note: string | null;
  };
  assessment: { title: string; max_points: number; items: PackItem[] };
  item_analytics: PackItemAnalytics[];
  tags: Array<{ tag: string; code: string; percent: number }>;
  students: PackStudent[];
  /** Every figure the report may cite, by stable key (D-3). */
  figures: Record<string, number>;
  /** sha256 of the canonical JSON of everything above. */
  hash: string;
}

export interface EvidencePackResult {
  pack: EvidencePack;
  /** `S<n>` → the attempt and name. Server-side only; never sent to a model. */
  names: Record<string, { attempt_id: string; display_name: string }>;
  /** `Q<n>` → the item id (slice 2: a stored report keeps its links when
   * positions later move). Server-side only, like `names`. */
  items: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pure helpers

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** A stem's pictures read as `[image: alt]` — asset ids are noise to a model. */
function stemText(stem: string): string {
  return truncate(
    stem.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) =>
      alt.trim() ? `[image: ${alt.trim()}]` : "[image]",
    ),
    STEM_MAX,
  );
}

/** FB slice 3: the stem with each blank as `[Blank n]` (the shared reading's numbering). */
function gappedStem(item: EvidenceItemInput): string {
  return fillBlankAnswer(item.stem, item.blanks, null)
    .segments.map((seg) => (seg.kind === "text" ? seg.text : `[Blank ${seg.blank.number}]`))
    .join("");
}

/**
 * FB slice 3: per blank, the answered / right counts (figures) and the most
 * common answers — a dropdown pick as its option text, a typed answer counted
 * on trim + case-fold and shown as its most common spelling (short_text's
 * rule). An answer whose response carries an open safeguarding alert is
 * counted but never listed.
 */
function blankAnswerCounts(
  item: EvidenceItemInput,
  label: string,
  itemResponses: EvidenceResponseInput[],
  openAlerts: ReadonlySet<string>,
  figures: Record<string, number>,
): NonNullable<PackItemAnalytics["blank_answers"]> {
  type Cluster = { count: number; spellings: Map<string, number>; right: boolean | null };
  const per = new Map<string, { answered: number; right: number; clusters: Map<string, Cluster> }>();
  const numbering = fillBlankAnswer(item.stem, item.blanks, null).blanks;
  for (const b of numbering) per.set(b.id, { answered: 0, right: 0, clusters: new Map() });
  for (const r of itemResponses) {
    const answers =
      r.response && typeof r.response.answers === "object" && r.response.answers !== null
        ? (r.response.answers as Record<string, unknown>)
        : {};
    for (const b of fillBlankAnswer(item.stem, item.blanks, answers).blanks) {
      const slot = per.get(b.id)!;
      if (b.answer === null) continue;
      slot.answered++;
      if (b.right === true) slot.right++;
      if (openAlerts.has(r.response_id)) continue;
      const shown = b.answer.trim();
      const norm = b.kind === "text" ? shown.toLowerCase() : shown;
      let c = slot.clusters.get(norm);
      if (!c) {
        c = { count: 0, spellings: new Map(), right: b.right };
        slot.clusters.set(norm, c);
      }
      c.count++;
      c.spellings.set(shown, (c.spellings.get(shown) ?? 0) + 1);
    }
  }
  return numbering.map((b) => {
    const slot = per.get(b.id)!;
    const n = b.number;
    figures[`item.${label}.blank.${n}.answered_count`] = slot.answered;
    if (b.keyed) figures[`item.${label}.blank.${n}.right_count`] = slot.right;
    return {
      blank: `Blank ${n}`,
      answered_count: slot.answered,
      right_count: b.keyed ? slot.right : null,
      answers: [...slot.clusters.entries()]
        .sort((x, y) => y[1].count - x[1].count || compareStrings(x[0], y[0]))
        .slice(0, TOP_ANSWERS)
        .map(([, c]) => {
          const [answer] = [...c.spellings.entries()].sort(
            (x, y) => y[1] - x[1] || compareStrings(x[0], y[0]),
          )[0]!;
          return { answer: shortText(answer, STEM_MAX), count: c.count, right: c.right };
        }),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percent(points: number, max: number): number | null {
  return max > 0 ? Math.round((100 * points) / max) : null;
}

function letter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `C${i + 1}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The pure transform

export function buildEvidencePackFromData(input: EvidencePackInput): EvidencePackResult {
  const itemList = [...input.assessment.items].sort((a, b) => a.position - b.position);
  const labelOf = new Map(itemList.map((i) => [i.id, `Q${i.position + 1}`]));
  const itemById = new Map(itemList.map((i) => [i.id, i]));
  const assessmentMax = itemList.reduce((s, i) => s + i.max_points, 0);
  const figures: Record<string, number> = {};

  // Scope: handed-in attempts only; in-progress ones are not results.
  const handedIn = input.attempts.filter((a) => a.status === "submitted");
  const handedInIds = new Set(handedIn.map((a) => a.attempt_id));
  const scopedResponses = input.responses.filter(
    (r) => handedInIds.has(r.attempt_id) && itemById.has(r.item_id),
  );
  const responsesByAttempt = new Map<string, EvidenceResponseInput[]>();
  for (const r of scopedResponses) {
    const list = responsesByAttempt.get(r.attempt_id);
    if (list) list.push(r);
    else responsesByAttempt.set(r.attempt_id, [r]);
  }

  const unscoredResponses = scopedResponses.filter((r) => r.final === null).length;
  const scoredAttempts = handedIn.filter((a) =>
    (responsesByAttempt.get(a.attempt_id) ?? []).every((r) => r.final !== null),
  ).length;
  const sectionLabel =
    input.section === null
      ? "all sections"
      : input.section === NO_SECTION_FILTER
        ? "no section"
        : input.section;
  const scope = {
    section: sectionLabel,
    handed_in: handedIn.length,
    scored: scoredAttempts,
    unscored_responses: unscoredResponses,
    note:
      unscoredResponses > 0
        ? `${unscoredResponses} response${unscoredResponses === 1 ? "" : "s"} not yet scored — score them first for a complete picture`
        : null,
  };
  figures["scope.handed_in"] = scope.handed_in;
  figures["scope.scored"] = scope.scored;
  figures["scope.unscored_responses"] = scope.unscored_responses;

  // Assessment header.
  const tagInfo = (tag: string) => {
    const chip = chipLabel(tag, input.tag_lookup?.[tag] ?? null);
    return { tag, code: chip.code, text: chip.text };
  };
  const packItems: PackItem[] = itemList.map((item) => {
    const out: PackItem = {
      label: labelOf.get(item.id)!,
      type: item.type,
      max_points: item.max_points,
      stem: stemText(item.type === "fill_blank" ? gappedStem(item) : item.stem),
      tags: item.standards.map(tagInfo),
    };
    if (item.type === "fill_blank") {
      out.blanks = fillBlankAnswer(item.stem, item.blanks, null).blanks.map((b) => {
        const source = item.blanks?.find((x) => x.id === b.id);
        return {
          label: `Blank ${b.number}`,
          kind: b.kind,
          ...(source?.kind === "dropdown"
            ? { options: source.options.map((o) => shortText(o.text, STEM_MAX)) }
            : {}),
          ...(b.keyed ? { keys: b.expected } : {}),
        };
      });
    }
    if (MC_TYPES.has(item.type) && item.choices && item.choices.length > 0) {
      const key = new Set(item.correct_choice_ids ?? []);
      out.choices = item.choices.map((c, i) => ({
        label: letter(i),
        text: shortText(c.text, STEM_MAX),
        is_key: key.has(c.id),
      }));
    }
    if (item.type === "short_text" && item.correct_answer) out.key = item.correct_answer;
    return out;
  });

  // Per-item analytics — R1's aggregation over the scoped rows.
  const analytics = buildItemAnalytics(
    itemList.map((i) => ({
      id: i.id,
      position: i.position,
      type: i.type,
      max_points: i.max_points,
      choices: i.choices,
      correct_choice_ids: i.correct_choice_ids,
    })),
    scopedResponses.map((r) => ({
      item_id: r.item_id,
      response: r.response,
      points: r.final?.points ?? null,
    })),
    handedIn.length,
  );
  const responsesByItem = new Map<string, EvidenceResponseInput[]>();
  for (const r of scopedResponses) {
    const list = responsesByItem.get(r.item_id);
    if (list) list.push(r);
    else responsesByItem.set(r.item_id, [r]);
  }

  const itemAnalytics: PackItemAnalytics[] = analytics.map((a) => {
    const item = itemById.get(a.item_id)!;
    const label = labelOf.get(a.item_id)!;
    const out: PackItemAnalytics = {
      label,
      answered_count: a.answered_count,
      answered_percent: a.answered_percent,
      scored_count: a.scored_count,
      unscored_count: a.unscored_count,
      mean: a.mean_points === null ? null : round2(a.mean_points),
      p_value: a.p_value,
    };
    figures[`item.${label}.answered_count`] = a.answered_count;
    figures[`item.${label}.max_points`] = item.max_points;
    if (a.answered_percent !== null) figures[`item.${label}.answered_percent`] = a.answered_percent;
    if (out.mean !== null) figures[`item.${label}.mean`] = out.mean;
    if (a.p_value !== null) figures[`item.${label}.p_value`] = a.p_value;

    if (a.choices) {
      out.choice_counts = a.choices.map((c, i) => {
        figures[`item.${label}.choice.${letter(i)}.count`] = c.count;
        return { label: letter(i), count: c.count, is_key: c.is_key };
      });
    }

    const itemResponses = responsesByItem.get(a.item_id) ?? [];
    if (item.type === "short_text") {
      // Counted on trim + case-fold; shown as the most common original
      // spelling. An answer with an open safeguarding alert never enters.
      const clusters = new Map<
        string,
        { count: number; spellings: Map<string, number>; points: number[] }
      >();
      for (const r of itemResponses) {
        if (input.open_alert_response_ids.has(r.response_id)) continue;
        const raw = typeof r.response?.text === "string" ? r.response.text.trim() : "";
        if (!raw) continue;
        const norm = raw.toLowerCase();
        let c = clusters.get(norm);
        if (!c) {
          c = { count: 0, spellings: new Map(), points: [] };
          clusters.set(norm, c);
        }
        c.count++;
        c.spellings.set(raw, (c.spellings.get(raw) ?? 0) + 1);
        if (r.final) c.points.push(r.final.points);
      }
      out.answers = [...clusters.entries()]
        .sort((x, y) => y[1].count - x[1].count || compareStrings(x[0], y[0]))
        .slice(0, TOP_ANSWERS)
        .map(([, c]) => {
          const [answer] = [...c.spellings.entries()].sort(
            (x, y) => y[1] - x[1] || compareStrings(x[0], y[0]),
          )[0]!;
          return {
            answer,
            count: c.count,
            mean_points:
              c.points.length > 0
                ? round2(c.points.reduce((s, p) => s + p, 0) / c.points.length)
                : null,
          };
        });
    }

    if (item.type === "fill_blank") {
      out.blank_answers = blankAnswerCounts(item, label, itemResponses, input.open_alert_response_ids, figures);
    }

    if (item.rubric) {
      // Levels ordered by points then label, so the pack (and its hash) does
      // not depend on the order the responses arrived in.
      const dist = new Map<string, Map<string, { points: number; count: number }>>();
      for (const c of item.rubric.criteria) dist.set(c.name, new Map());
      for (const r of itemResponses) {
        if (!r.final) continue;
        for (const row of rubricScoreRows(item.rubric, r.final.rationale)) {
          let levels = dist.get(row.criterion_name);
          if (!levels) {
            levels = new Map();
            dist.set(row.criterion_name, levels);
          }
          const level = levels.get(row.level_label) ?? { points: row.points, count: 0 };
          level.count++;
          levels.set(row.level_label, level);
        }
      }
      out.criteria = [...dist.entries()].map(([criterion, levels]) => ({
        criterion,
        levels: [...levels.entries()]
          .sort((x, y) => x[1].points - y[1].points || compareStrings(x[0], y[0]))
          .map(([level, { count }]) => {
            figures[`item.${label}.criterion.${criterion}.${level}.count`] = count;
            return { level, count };
          }),
      }));
    }
    return out;
  });

  // Per-tag class percent: final points over final max, tagged items only.
  const tagTotals = new Map<string, { points: number; max: number }>();
  const addTag = (map: Map<string, { points: number; max: number }>, tag: string, p: number, m: number) => {
    const t = map.get(tag) ?? { points: 0, max: 0 };
    t.points += p;
    t.max += m;
    map.set(tag, t);
  };
  for (const r of scopedResponses) {
    if (!r.final) continue;
    for (const tag of itemById.get(r.item_id)!.standards) {
      addTag(tagTotals, tag, r.final.points, r.final.max_points);
    }
  }
  const tags = [...tagTotals.entries()]
    .sort((x, y) => compareStrings(x[0], y[0]))
    .flatMap(([tag, t]) => {
      const p = percent(t.points, t.max);
      if (p === null) return [];
      figures[`tag.${tag}.percent`] = p;
      return [{ tag, code: tagInfo(tag).code, percent: p }];
    });

  // Per student: handed-in attempts with at least one final score, as
  // S1…Sn in ascending attempt-id order — stable, and tied to neither the
  // name nor the score.
  const withFinals = handedIn
    .filter((a) => (responsesByAttempt.get(a.attempt_id) ?? []).some((r) => r.final !== null))
    .sort((x, y) => compareStrings(x.attempt_id, y.attempt_id));
  const names: EvidencePackResult["names"] = {};
  const students: PackStudent[] = withFinals.map((attempt, i) => {
    const id = `S${i + 1}`;
    names[id] = { attempt_id: attempt.attempt_id, display_name: attempt.display_name };
    const byItem = new Map(
      (responsesByAttempt.get(attempt.attempt_id) ?? []).map((r) => [r.item_id, r]),
    );
    let total = 0;
    let unscored = 0;
    const studentTags = new Map<string, { points: number; max: number }>();
    const essays: PackStudent["essays"] = [];
    const perItem = itemList.map((item) => {
      const label = labelOf.get(item.id)!;
      const r = byItem.get(item.id);
      if (r && !r.final) unscored++;
      if (!r?.final) return { label, points: null, max_points: item.max_points };
      total += r.final.points;
      figures[`student.${id}.item.${label}.points`] = r.final.points;
      for (const tag of item.standards) addTag(studentTags, tag, r.final.points, r.final.max_points);
      if (item.rubric) {
        // The scorer's rationale is withheld for an alert-flagged answer:
        // it describes that writing. The levels still count.
        const rationale = input.open_alert_response_ids.has(r.response_id)
          ? null
          : overallRationale(r.final.rationale);
        essays.push({
          label,
          criteria: rubricScoreRows(item.rubric, r.final.rationale).map((c) => ({
            criterion: c.criterion_name,
            level: c.level_label,
            points: c.points,
          })),
          rationale: rationale === null ? null : truncate(rationale, RATIONALE_MAX),
        });
      }
      return { label, points: r.final.points, max_points: item.max_points };
    });
    figures[`student.${id}.total`] = total;
    figures[`student.${id}.max`] = assessmentMax;
    const tagPercents = [...studentTags.entries()]
      .sort((x, y) => compareStrings(x[0], y[0]))
      .flatMap(([tag, t]) => {
        const p = percent(t.points, t.max);
        if (p === null) return [];
        figures[`student.${id}.tag.${tag}.percent`] = p;
        return [{ tag, percent: p }];
      });
    return {
      id,
      total,
      max: assessmentMax,
      unscored,
      items: perItem,
      tags: tagPercents,
      essays,
    };
  });

  const body = {
    scope,
    assessment: { title: input.assessment.title, max_points: assessmentMax, items: packItems },
    item_analytics: itemAnalytics,
    tags,
    students,
    figures,
  };
  const hash = createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
  const itemIds: Record<string, string> = {};
  for (const item of itemList) itemIds[labelOf.get(item.id)!] = item.id;
  return { pack: { ...body, hash }, names, items: itemIds };
}

// ---------------------------------------------------------------------------
// The loader

/**
 * The caller must ALREADY have cleared `assessmentId` through
 * `authorizeAssessment` / `pageAssessment` — the same precondition
 * `buildResults` carries; nothing here checks access.
 *
 * @param section null = all sections; NO_SECTION_FILTER = the rows with no
 *   section resolved; else a section label as the results page's filter
 *   offers it (D-7: one section per report).
 */
export async function buildEvidencePack(
  db: ReturnType<typeof getDb>,
  {
    assessmentId,
    section,
    results: prebuilt,
  }: {
    assessmentId: string;
    section: string | null;
    /** A `buildResults(assessmentId)` the caller already holds (slice 2's GET
     * needs it for the name swap too); omitted, the loader builds its own. */
    results?: Awaited<ReturnType<typeof buildResults>>;
  },
): Promise<EvidencePackResult> {
  const [assessment] = await db
    .select({ name: assessments.name })
    .from(assessments)
    .where(eq(assessments.id, assessmentId))
    .limit(1);
  if (!assessment) throw new Error(`buildEvidencePack: assessment ${assessmentId} not found`);

  // Owner-scoped students, practice excluded, section labels resolved.
  // In-progress attempts are left out here; the pure half drops them too.
  const results = prebuilt ?? (await buildResults(assessmentId));
  const rows =
    section === null
      ? results.rows
      : section === NO_SECTION_FILTER
        ? results.rows.filter((r) => !r.student.section)
        : results.rows.filter((r) => r.student.section === section);
  const attemptIds = rows.map((r) => r.attempt_id);

  const itemRows = await db.select().from(items).where(eq(items.assessment_id, assessmentId));

  // Every response of the scoped attempts with its FINAL score (one at most,
  // by the partial unique index). A proposed, superseded or research row
  // never joins — the same rule buildResults and loadItemAnalytics apply.
  const responseRows =
    attemptIds.length > 0
      ? await db
          .select({
            response_id: responses.id,
            attempt_id: responses.attempt_id,
            item_id: responses.item_id,
            response: responses.response,
            points: scores.points,
            max_points: scores.max_points,
            rationale: scores.rationale,
          })
          .from(responses)
          .leftJoin(scores, and(eq(scores.response_id, responses.id), eq(scores.status, "final")))
          .where(inArray(responses.attempt_id, attemptIds))
      : [];

  const alertRows =
    responseRows.length > 0
      ? await db
          .selectDistinct({ response_id: safeguarding_alerts.response_id })
          .from(safeguarding_alerts)
          .where(
            and(
              inArray(
                safeguarding_alerts.response_id,
                responseRows.map((r) => r.response_id),
              ),
              isNull(safeguarding_alerts.acknowledged_at),
            ),
          )
      : [];

  const allTags = [...new Set(itemRows.flatMap((i) => i.standards ?? []))];
  return buildEvidencePackFromData({
    assessment: {
      title: assessment.name,
      items: itemRows.map((i) => ({
        id: i.id,
        position: i.position,
        type: i.type,
        stem: i.stem,
        max_points: itemMaxPoints(i),
        standards: i.standards ?? [],
        choices: i.choices as Array<{ id: string; text: string }>,
        correct_choice_ids: i.correct_choice_ids as string[],
        correct_answer: i.correct_answer,
        rubric: i.config?.rubric ?? null,
        blanks: i.type === "fill_blank" ? (i.config?.blanks ?? []) : null,
      })),
    },
    section,
    attempts: rows.map((r) => ({
      attempt_id: r.attempt_id,
      status: r.status,
      display_name: r.student.name,
    })),
    responses: responseRows.map((r) => ({
      response_id: r.response_id,
      attempt_id: r.attempt_id,
      item_id: r.item_id,
      response: r.response as unknown as Record<string, unknown> | null,
      final:
        r.points === null || r.max_points === null
          ? null
          : { points: r.points, max_points: r.max_points, rationale: r.rationale },
    })),
    open_alert_response_ids: new Set(
      alertRows.map((r) => r.response_id).filter((v): v is string => !!v),
    ),
    tag_lookup: lookupTags(allTags),
  });
}
