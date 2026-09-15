import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  assessments,
  assets,
  item_sets,
  items,
  responses,
  scores,
  type ItemRow,
  type ScoreRow,
  type StimulusSourceRow,
} from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";
import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";
import { describeAnswer, type AnswerLine } from "@/lib/reporting/answerView";
import {
  overallRationale,
  rubricScoreRows,
  type RubricScoreRow,
} from "@/lib/reporting/rubricScoreView";
import {
  anonymousLabels,
  choiceCheckboxLines,
  packetOrdering,
  packetScoreHeading,
  parsePacketQuery,
  selectPacketScores,
} from "@/lib/reporting/workPacket";
import { studentsInTeachersSections } from "@/lib/roster/queries";
import { sectionLabel } from "@/lib/roster/teacherRoster";
import { tableCellMatches } from "@/lib/scoring/auto";
import { buildResults, type ResultsRow } from "@/lib/scoring/results";
import { formatDate, formatDateTime } from "@/lib/ui/format";
import { UUID_RE } from "@/lib/uuid";

/**
 * Student work export — the printable class packet
 * (docs/student-work-export-design.md, slices 0–1). A pilot-teacher request:
 * one page per student, a new sheet each, one PDF per class, an inch of margin
 * to annotate in, checkboxes on every multiple-choice option, and scores from
 * the teacher, the AI, both or neither.
 *
 * FERPA posture — READ THE DESIGN PAGE. This page is deliberately NOT the
 * print report. `results/print/page.tsx` carries a hard rule in its header,
 * "NEVER a free-text response", and that rule stays true of the report. This
 * page **prints student names, student numbers and what students wrote**,
 * because that is the thing a teacher asked for and it happens only by their
 * explicit action on their own assessment. Everything else about the posture
 * is the report's: owner-only through the same helper chain, every failure is
 * `notFound()` so the URL cannot probe for an assessment, `no-store`, no
 * client JS beyond the print button, and no student identifier in the URL
 * beyond the section label. Anonymous mode (D-1) exists so a packet can leave
 * the teacher's hands — labels everywhere, and the name ↔ label mapping only
 * on a tear-off key page at the very end.
 *
 * URL contract (docs/student-work-export-design.md §The page):
 *   /dashboard/<assessmentId>/results/work
 *     ?section=<label>   REQUIRED — one PDF per class is one URL per section.
 *                        Without it the page renders a screen-only list of the
 *                        sections that have handed-in work and prints nothing.
 *     ?items=<uuid,...>  the questions to include; default every one
 *     ?questions=0       answers only (no stems, stimulus or unselected choices)
 *     ?scores=none|teacher|ai|both
 *     ?anon=1            labels instead of names, key page last
 *
 * Handed-in attempts only: an in-progress answer can still change and a packet
 * is a record.
 */

// Same reason as the print report: force-dynamic is what makes Next answer
// with `private, no-cache, no-store` — a page cannot set headers itself.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

// Black on white, 11pt, an inch of margin — the request's one hard number, so
// a hand-run row measures it in the saved PDF. Screen keeps the same document
// and only adds the strip above it, so what the teacher reads is what prints.
const PRINT_CSS = `
.packet { color: #000; background: #fff; font-size: 11pt; line-height: 1.45;
  max-width: 52rem; margin: 0 auto; padding: 1.5rem; }
.packet h1 { font-size: 15pt; margin: 0 0 .25rem; }
.packet h2 { font-size: 13pt; margin: 0 0 .25rem; }
.packet h3 { font-size: 11pt; margin: 0 0 .25rem; }
.packet .meta { margin: 0 0 .15rem; }
.packet .muted { color: #333; }
.packet .student-page { margin-top: 2.5rem; padding-top: 1rem; border-top: 2px solid #000; }
.packet .student-page:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.packet .item { margin-top: 1.25rem; break-inside: avoid; page-break-inside: avoid; }
/* A long essay paginates rather than overflowing: no avoid rule on a text
   answer's block (design page, Print CSS). */
.packet .item-flow { break-inside: auto; page-break-inside: auto; }
.packet .qnum { font-weight: 600; }
.packet .stem { margin: .15rem 0 .35rem; white-space: pre-line; }
.packet .stimulus { margin: 1.25rem 0 .25rem; padding: .5rem .75rem;
  border: 1px solid #000; break-inside: avoid; page-break-inside: avoid; }
.packet .stimulus-body, .packet .source-body { margin: 0; white-space: pre-line; }
.packet .source { margin-top: .5rem; }
.packet .source-label { font-weight: 600; }
.packet .answer { margin-top: .25rem; }
.packet .answer-text { white-space: pre-line; border: 1px solid #000;
  padding: .4rem .5rem; margin: 0; }
.packet .choices, .packet .lines { list-style: none; padding: 0; margin: 0; }
.packet .choices li, .packet .lines li { margin: 0 0 .1rem; }
.packet .box { font-family: inherit; margin-right: .35rem; }
.packet table { border-collapse: collapse; width: 100%; margin-top: .4rem; }
.packet th, .packet td { border: 1px solid #000; padding: .2rem .35rem;
  text-align: left; vertical-align: top; }
.packet img { max-width: 100%; }
.packet .scores { margin-top: .5rem; display: grid; gap: .75rem;
  grid-template-columns: 1fr 1fr; break-inside: avoid; page-break-inside: avoid; }
.packet .scores-one { grid-template-columns: 1fr; }
.packet .score-block { border: 1px solid #000; padding: .4rem .5rem; }
.packet .page-footer { margin-top: 1.5rem; padding-top: .35rem;
  border-top: 1px solid #000; font-size: 9pt; color: #333; }
.packet .key-page table { width: auto; }
.strip { margin: 0 auto 1rem; max-width: 52rem; padding: 1rem 1.5rem 0;
  display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; }
@media print {
  header, nav, .strip, .screen-only { display: none !important; }
  .packet { max-width: none; padding: 0; font-size: 11pt; }
  .packet .student-page { page-break-before: always; break-before: page;
    margin-top: 0; padding-top: 0; border-top: none; }
  .packet .student-page:first-child { page-break-before: auto; break-before: auto; }
  @page { size: letter; margin: 1in; }
}
`;

const PRINT_SCRIPT = `document.addEventListener("click",function(e){
var b=e.target&&e.target.closest&&e.target.closest("[data-print]");
if(b){window.print();}});`;

function printWhen(iso: string | null): string {
  return iso ? formatDateTime(iso) : "—";
}

/** answerView's lines, with the ✓ / ✗ it supplies only where a key exists. */
function AnswerLines({ lines }: { lines: AnswerLine[] }) {
  if (lines.length === 0) return <p className="meta muted">Nothing selected.</p>;
  return (
    <ul className="lines">
      {lines.map((line, i) => (
        <li key={i}>
          {line.correct === null ? null : <span>{line.correct ? "✓" : "✗"} </span>}
          {line.text}
        </li>
      ))}
    </ul>
  );
}

/** The per-student page's grid, in print ink: the student's cells, key beside. */
function TableGrid({
  item,
  cells,
}: {
  item: ItemRow;
  cells: Record<string, Record<string, string>>;
}) {
  const columns = item.config.columns ?? [];
  const rows = item.config.rows ?? [];
  const keys = item.config.cell_keys ?? {};
  const showLabels = rows.some((r) => r.label.trim().length > 0);
  return (
    <table>
      <thead>
        <tr>
          {showLabels ? <th>{item.config.corner ?? ""}</th> : null}
          {columns.map((c) => (
            <th key={c.id}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            {showLabels ? <th>{r.label}</th> : null}
            {columns.map((c) => {
              const answer = cells[r.id]?.[c.id];
              const key = keys[r.id]?.[c.id];
              const ok = key !== undefined ? tableCellMatches(answer ?? "", key) : null;
              return (
                <td key={c.id}>
                  <div>{answer !== undefined && answer !== "" ? answer : "—"}</div>
                  {key !== undefined ? (
                    <div className="muted">
                      {ok ? "✓" : "✗"} expected {key}
                    </div>
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One score block: points, the criterion rows and the overall note. */
function ScoreBlock({
  heading,
  row,
  rubricRows,
  overall,
}: {
  heading: string;
  row: { points: number; max_points: number } | null;
  rubricRows: RubricScoreRow[];
  overall: string | null;
}) {
  return (
    <div className="score-block">
      <h3>{heading}</h3>
      {row ? (
        <p className="meta">
          <strong>
            {row.points} / {row.max_points}
          </strong>
        </p>
      ) : (
        <p className="meta muted">—</p>
      )}
      {rubricRows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Level</th>
              <th>Points</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rubricRows.map((r) => (
              <tr key={r.criterion_id}>
                <td>{r.criterion_name}</td>
                <td>{r.level_label}</td>
                <td>{r.points}</td>
                <td>{r.rationale ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {overall ? <p className="meta muted">{overall}</p> : null}
    </div>
  );
}

export default async function StudentWorkPacketPage({ params, searchParams }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }
  const query = parsePacketQuery(await searchParams);

  const db = getDb();
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  // Owner-only, and a non-owner gets the SAME answer as a missing row.
  if (!assessment || assessment.owner_sub !== session.sub) {
    notFound();
  }

  // Submitted only — buildResults' default — so an in-progress answer can
  // never reach a packet.
  const results = await buildResults(id, session.sub, session.email);
  const handedIn = results.rows.filter((r) => r.status === "submitted");

  // ── No section: the chooser. One URL per section is the contract, so rather
  // than printing "all sections" this lists what there is to print. Screen
  // only; there is nothing printable on this branch. Slice 2 replaces it with
  // the full toolbar.
  if (query.section === null) {
    const counts = new Map<string, number>();
    let unsectioned = 0;
    for (const row of handedIn) {
      if (row.student.section) {
        counts.set(row.student.section, (counts.get(row.student.section) ?? 0) + 1);
      } else {
        unsectioned++;
      }
    }
    const sections = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return (
      <main className="mx-auto max-w-2xl space-y-4 px-6 py-10">
        <h1 className="text-2xl font-semibold">Print student work</h1>
        <p className="text-sm text-muted-foreground">
          One packet per class: pick a section. {assessment.name}
        </p>
        {sections.length === 0 ? (
          <p className="text-sm">
            No handed-in work carries a section yet, so there is nothing to
            print. A section comes from the test session that named one, or
            from the student&apos;s enrollment in a section you teach.
          </p>
        ) : (
          <ul className="space-y-2">
            {sections.map(([label, count]) => (
              <li key={label}>
                <a
                  className="underline"
                  href={`/dashboard/${assessment.id}/results/work?section=${encodeURIComponent(label)}`}
                >
                  {label}
                </a>{" "}
                <span className="text-sm text-muted-foreground">
                  — {count} handed in
                </span>
              </li>
            ))}
          </ul>
        )}
        {unsectioned > 0 ? (
          <p className="text-sm text-muted-foreground">
            {unsectioned} handed-in attempt{unsectioned === 1 ? "" : "s"} resolve
            to no section and are in no packet.
          </p>
        ) : null}
        <a
          className="text-sm underline"
          href={`/dashboard/${assessment.id}/results`}
        >
          Back to results
        </a>
      </main>
    );
  }

  const section = query.section;
  const inSection = handedIn.filter((r) => r.student.section === section);
  const ordered = packetOrdering(inSection, query.anon);
  const labels = query.anon
    ? anonymousLabels(ordered.map((r) => r.attempt_id))
    : null;

  // "N of M students in <section> handed in": M is the section's current
  // enrollment in the sections this teacher teaches — the same query the
  // results matrix resolves its labels through. Null when the session carries
  // no email (older sessions), and the strip then says N alone.
  let enrolled: number | null = null;
  if (session.email) {
    const rostered = await studentsInTeachersSections(db, session.email);
    enrolled = rostered.filter((r) => sectionLabel(r.section) === section).length;
  }

  // ── Items, in delivery order, narrowed by ?items=.
  const allItems = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));
  const includedItems =
    query.items === null
      ? allItems
      : allItems.filter((i) => query.items!.includes(i.id.toLowerCase()));

  // ── The sets whose stimulus / sources open an included item's group. A set
  // prints ONCE, above the first of its items that this packet includes.
  const setRows = await db
    .select()
    .from(item_sets)
    .where(eq(item_sets.assessment_id, id));
  const setsById = new Map(setRows.map((s) => [s.id, s]));
  const setOpensAtItem = new Map<string, string>(); // item id -> set id
  const seenSets = new Set<string>();
  for (const item of includedItems) {
    if (!item.item_set_id || seenSets.has(item.item_set_id)) continue;
    if (!setsById.has(item.item_set_id)) continue;
    seenSets.add(item.item_set_id);
    setOpensAtItem.set(item.id, item.item_set_id);
  }

  // ── Asset refs, resolved owner-scoped in one query, exactly as the
  // per-student page does: stems, choice texts, stimulus introductions and
  // source bodies all follow the stem's content rules.
  const refTexts: string[] = [];
  for (const item of includedItems) {
    refTexts.push(item.stem);
    for (const c of item.choices as Array<{ text?: unknown }>) {
      if (typeof c.text === "string") refTexts.push(c.text);
    }
  }
  for (const setId of seenSets) {
    const set = setsById.get(setId)!;
    refTexts.push(set.stimulus_text);
    for (const src of set.sources) refTexts.push(src.text);
  }
  const refs = extractAssetRefsFromMany(refTexts);
  const resolvedAssets = new Map<string, ResolvedAsset>();
  if (refs.length > 0) {
    const assetRows = await db
      .select({ id: assets.id, content_type: assets.content_type })
      .from(assets)
      .where(and(eq(assets.owner_sub, session.sub), inArray(assets.id, refs)));
    for (const a of assetRows) {
      resolvedAssets.set(a.id.toLowerCase(), { id: a.id, content_type: a.content_type });
    }
  }

  // ── Responses and scores for this section's attempts only.
  const attemptIds = ordered.map((r) => r.attempt_id);
  const responseRows =
    attemptIds.length > 0
      ? await db.select().from(responses).where(inArray(responses.attempt_id, attemptIds))
      : [];
  const responseByCell = new Map(
    responseRows.map((r) => [`${r.attempt_id}:${r.item_id}`, r]),
  );

  const scoreRows =
    query.scores !== "none" && responseRows.length > 0
      ? await db
          .select()
          .from(scores)
          .where(
            // Research rows (docs/scoring-corpus-design.md) are an operator's
            // data set: never on a page a student or a family could hold.
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              ne(scores.status, "research"),
            ),
          )
      : [];
  const scoresByResponse = new Map<string, ScoreRow[]>();
  for (const s of scoreRows) {
    const list = scoresByResponse.get(s.response_id);
    if (list) list.push(s);
    else scoresByResponse.set(s.response_id, [s]);
  }

  function identityLine(row: ResultsRow): string {
    if (labels) return labels.get(row.attempt_id) ?? "Student";
    return [row.student.name, row.student.student_number].filter(Boolean).join(" · ");
  }

  const printedOn = formatDate(new Date());

  return (
    <>
      <style>{PRINT_CSS}</style>
      {/* Slice 2 of docs/student-work-export-design.md puts the toolbar form
          HERE — the section select, the item checklist, the questions toggle,
          the scores radio and the anonymous checkbox, as a plain GET form back
          to this same route. Until then the options are URL parameters and
          this strip carries the counts and the print button only. */}
      <div className="strip">
        <button type="button" data-print className="rounded-md border px-3 py-1.5 text-sm">
          Print / Save as PDF
        </button>
        <span className="text-sm">
          {enrolled === null
            ? `${ordered.length} handed in`
            : `${ordered.length} of ${enrolled} students in ${section} handed in`}
        </span>
        <a
          href={`/dashboard/${assessment.id}/results`}
          className="text-sm underline"
        >
          Back to results
        </a>
      </div>
      <main className="packet">
        {ordered.length === 0 ? (
          <p className="meta">
            Nobody in {section} has handed this in yet, so there is nothing to
            print.
          </p>
        ) : null}

        {ordered.map((row) => (
          <section
            key={row.attempt_id}
            className="student-page"
            aria-label={
              labels
                ? `Work for ${labels.get(row.attempt_id)}`
                : `Work for ${row.student.name}`
            }
          >
            <h2>{identityLine(row)}</h2>
            <p className="meta">
              {section} · {assessment.name}
            </p>
            <p className="meta muted">Handed in {printWhen(row.submitted_at)}</p>

            {includedItems.map((item) => {
              const setId = setOpensAtItem.get(item.id);
              const set = setId ? setsById.get(setId)! : null;
              const response = responseByCell.get(`${row.attempt_id}:${item.id}`);
              const responseJson = response
                ? (response.response as unknown as Record<string, unknown>)
                : null;
              const view = describeAnswer(
                {
                  type: item.type,
                  choices: item.choices as Array<{ id: string; text: string }>,
                  correct_choice_ids: item.correct_choice_ids as string[],
                  correct_answer: item.correct_answer,
                  config: item.config,
                },
                responseJson,
              );
              const boxes = query.questions
                ? choiceCheckboxLines(
                    {
                      type: item.type,
                      choices: item.choices as Array<{ id: string; text: string }>,
                    },
                    responseJson,
                  )
                : [];
              const picked = selectPacketScores(query.scores, [
                ...(response ? (scoresByResponse.get(response.id) ?? []) : []),
              ]);
              const rubric = item.config.rubric ?? null;
              const isText = view.kind === "text";
              return (
                <div key={item.id}>
                  {/* A set's stimulus and sources print once, above the first
                      of its questions in this packet. Suppressed with
                      ?questions=0, which is an answers-only packet. */}
                  {set && query.questions ? (
                    <StimulusBlock set={set} resolved={resolvedAssets} />
                  ) : null}
                  <div className={`item${isText ? " item-flow" : ""}`}>
                    <p className="qnum">Q{item.position + 1}</p>
                    {query.questions ? (
                      <div
                        className="stem"
                        dangerouslySetInnerHTML={{
                          __html: renderItemContent(item.stem, resolvedAssets),
                        }}
                      />
                    ) : null}
                    {/* Hotspot: the picture, then the regions the student
                        picked beneath it (no overlay drawing in v1). */}
                    {query.questions &&
                    item.type === "hotspot" &&
                    item.config.image_asset_id ? (
                      <img
                        src={`/api/assets/${encodeURIComponent(item.config.image_asset_id)}`}
                        alt={`Picture for question ${item.position + 1}`}
                      />
                    ) : null}

                    <div className="answer">
                      {view.kind === "none" ? (
                        <p className="meta muted">No answer.</p>
                      ) : isText && view.kind === "text" ? (
                        <p className="answer-text">
                          {view.text === "" ? "(blank)" : view.text}
                        </p>
                      ) : boxes.length > 0 ? (
                        <ul className="choices">
                          {boxes.map((b) => (
                            <li key={b.id}>
                              <span className="box">{b.selected ? "☑" : "☐"}</span>
                              {b.text}
                            </li>
                          ))}
                        </ul>
                      ) : view.kind === "drawing" && response ? (
                        <img
                          src={`/api/responses/${response.id}/upload`}
                          alt={`Drawing for question ${item.position + 1}`}
                        />
                      ) : view.kind === "table" && response ? (
                        <TableGrid
                          item={item}
                          cells={
                            (
                              response.response as unknown as {
                                cells?: Record<string, Record<string, string>>;
                              }
                            ).cells ?? {}
                          }
                        />
                      ) : view.kind === "lines" ? (
                        <AnswerLines lines={view.lines} />
                      ) : null}
                    </div>

                    {query.scores === "none" ? null : (
                      // Two columns only for `both`, and only while both sides
                      // have something to show: one lonely block in a
                      // half-width column reads as a rendering bug.
                      <div
                        className={
                          query.scores === "both" && picked.teacher && picked.ai
                            ? "scores"
                            : "scores scores-one"
                        }
                      >
                        {query.scores === "ai" ? null : (
                          <ScoreBlock
                            heading={packetScoreHeading("teacher", picked.teacher)}
                            row={picked.teacher}
                            rubricRows={rubricScoreRows(rubric, picked.teacher?.rationale)}
                            overall={overallRationale(picked.teacher?.rationale)}
                          />
                        )}
                        {query.scores === "teacher" ? null : (
                          <ScoreBlock
                            heading={packetScoreHeading("ai", picked.ai)}
                            row={picked.ai}
                            rubricRows={rubricScoreRows(rubric, picked.ai?.rationale)}
                            overall={overallRationale(picked.ai?.rationale)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Page numbers are the browser's; this is the identity line that
                gets a loose annotated sheet back to the right student. */}
            <p className="page-footer">
              {assessment.name} · {identityLine(row)}
            </p>
          </section>
        ))}

        {/* D-1: the key page, last, so it tears off. */}
        {labels && ordered.length > 0 ? (
          <section className="student-page key-page" aria-label="Teacher key">
            <h2>Teacher key — do not distribute</h2>
            <p className="meta">
              {assessment.name} · {section}
            </p>
            <p className="meta">
              Printed {printedOn} · {ordered.length} handed-in attempt
              {ordered.length === 1 ? "" : "s"}
            </p>
            <p className="meta muted">
              Labels are assigned over the {ordered.length} attempt
              {ordered.length === 1 ? "" : "s"} handed in as of this print. If
              another student hands in and you print again, the labels can
              shift — keep this page with its packet.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Student</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((row) => (
                  <tr key={row.attempt_id}>
                    <td>{labels.get(row.attempt_id)}</td>
                    <td>
                      {[row.student.name, row.student.student_number]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </main>
      {/* The one script on the page, same as the report's. */}
      <script dangerouslySetInnerHTML={{ __html: PRINT_SCRIPT }} />
    </>
  );
}

/**
 * A set's stimulus introduction and its labelled sources, rendered through the
 * same `renderItemContent` the stems go through so KaTeX, emphasis and image
 * refs cannot drift from the preview or the client.
 */
function StimulusBlock({
  set,
  resolved,
}: {
  set: { stimulus_text: string; sources: StimulusSourceRow[] };
  resolved: Map<string, ResolvedAsset>;
}) {
  const lead = set.stimulus_text.trim();
  const sources = set.sources ?? [];
  if (lead === "" && sources.length === 0) return null;
  return (
    <section className="stimulus" aria-label="Stimulus">
      {lead === "" ? null : (
        <div
          className="stimulus-body"
          dangerouslySetInnerHTML={{ __html: renderItemContent(lead, resolved) }}
        />
      )}
      {sources.map((src, i) => (
        <div className="source" key={`${src.label}-${i}`}>
          <p className="source-label">{src.label}</p>
          <div
            className="source-body"
            dangerouslySetInnerHTML={{ __html: renderItemContent(src.text, resolved) }}
          />
        </div>
      ))}
    </section>
  );
}
