import { Fragment } from "react";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  attempt_feedback,
  item_sets,
  items,
  response_feedback,
  responses,
  scores,
  type ItemRow,
  type ScoreRow,
  type StimulusSourceRow
} from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";
import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";
import { assessmentAssetUrl, resolveAssessmentAssets } from "@/lib/assets/assessmentAssets";
import { describeAnswer, type AnswerLine } from "@/lib/reporting/answerView";
import { renderFillBlankAnswerHtml, renderFillBlankGapsHtml } from "@/lib/reporting/fillBlankView";
import { renderShortTextAnswer } from "@/lib/reporting/shortTextView";
import { renderEssayAnswerHtml } from "@/lib/richText/renderEssayAnswer";
import {
  buildFeedbackRelease,
  questionRubric,
  type FeedbackBlock,
} from "@/lib/reporting/feedbackRelease";
import { CONTENT_OPTIONS } from "@/lib/googleDocs/sendDialog";
import {
  choiceCheckboxLines,
  packetHidesAnswers,
  packetPrintsBlocks,
  packetScoreBlocks,
  packetShowsKey,
  parsePacketQuery,
  keyCountLine,
  PACKET_CONTENT_KEYS,
  sectionAnonymousLabels,
  selectPacket,
  studentChoices,
  stemExcerpt,
  stripLine,
  type PacketQuery,
  type PacketRun,
  type PacketScoreBlock,
} from "@/lib/reporting/workPacket";
import { tableCellMatches, fillBlankHandScored } from "@/lib/scoring/auto";
import { buildResults, sectionEnrolment, type ResultsRow } from "@/lib/scoring/results";
import { formatDate, formatDateTime } from "@/lib/ui/format";
import { UUID_RE } from "@/lib/uuid";
import { pageAssessment } from "@/lib/api/access";

/**
 * Student work export — the printable class packet
 * (docs/student-work-export-design.md, slices 0–1). A pilot-teacher request:
 * one page per student, a new sheet each, one PDF per class, an inch of margin
 * to annotate in, checkboxes on every multiple-choice option, and — since FR
 * slice 4 (docs/feedback-release-design.md) — any combination of teacher
 * score, AI score, teacher feedback, AI feedback and a rubric table, each
 * labelled by its source (D-1, D-2, R-2).
 *
 * FERPA posture — READ THE DESIGN PAGE. This page is deliberately NOT the
 * print report. `results/print/page.tsx` carries a hard rule in its header,
 * "NEVER a free-text response", and that rule stays true of the report. This
 * page **prints student names, student numbers and what students wrote**,
 * because that is the thing a teacher asked for and it happens only by their
 * explicit action on an assessment they can open. Everything else about the
 * posture is the report's: `view` on the assessment through the same helper
 * chain (G-3, docs/coteacher-gaps-2026-10-design.md D-3: a co-teacher prints
 * too), every failure is `notFound()` so the URL cannot probe for an
 * assessment, `no-store`, no client JS beyond the print button, and no
 * student identifier in the URL beyond the section label. Anonymous mode
 * (D-1) exists so a packet can leave the teacher's hands — labels
 * everywhere, and the name ↔ label mapping only on a tear-off key page at
 * the very end. Anonymous mode cannot reach inside free text: a teacher's
 * feedback could name the student, and prints as written.
 *
 * FR (docs/feedback-release-design.md): the page also prints the teacher's
 * own feedback (`response_feedback` per question, `attempt_feedback` once
 * per student — student-record content, D-4 / FERPA there), read only when
 * that box is ticked. The default is the STUDENT copy: an AI score prints only
 * while it is the response's final score (D-3, D-17), so a score the teacher
 * overrode never reaches a student, and AI feedback comes from the AI's own
 * row (D-10). "Teacher copy" (D-16) brings back the AI proposal headings for
 * a teacher to annotate, each score block with its own row's rubric levels
 * when the rubric table is ticked. A score-change reason (`rationale.note`) never
 * prints in either. Nothing here logs — keep it that way: feedback text never
 * goes to a log (D-14).
 *
 * URL contract (docs/student-work-export-design.md §The page):
 *   /dashboard/<assessmentId>/results/work
 *     ?section=<label>   REQUIRED — one PDF per class is one URL per section.
 *                        Without it the page renders a screen-only list of the
 *                        sections that have handed-in work and prints nothing.
 *     ?attempt=<uuid>    ONE student's work instead, no section needed (the
 *                        per-student page's button and the toolbar's student
 *                        picker). An id that is not an attempt at this
 *                        assessment is notFound(). With a `section` it does
 *                        not belong to, the section wins — the toolbar's
 *                        picker only offers the chosen section's students.
 *     ?items=<uuid,...>  the questions to include; default every one
 *     ?questions=0       answers only (no stems, stimulus or unselected choices)
 *     ?teacher_score=1 ?ai_score=1 ?teacher_feedback=1 ?ai_feedback=1
 *     ?rubric_table=1    FR D-2 / R-2: the boxes, each off when absent
 *     ?teacher_copy=1    FR D-16: AI proposals and today's headings, to annotate
 *     ?scores=none|teacher|ai|both
 *                        legacy (before FR): read only when none of the boxes
 *                        is in the URL, as the two score boxes (`both` = both)
 *     ?anon=1            labels instead of names, key page last
 *     ?spacing=double    every essay answer double-spaced (RT D-10; default single)
 *     ?answers=0         feedback without the answer (U-23, FR D-11): the question
 *                        and the score / feedback blocks print, what the student
 *                        wrote or chose does not. Ignored with no box ticked
 *                        (nothing would print).
 *
 * The section packet is handed-in attempts only: an in-progress answer can
 * still change and a packet is a record. `?attempt=` (a pilot teacher,
 * 2026-09-23: "print their response so they can do their reflection") prints
 * an in-progress attempt too, with the answers saved so far, marked "In
 * progress — not handed in" on the printed page itself.
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
/* RT D-10 (docs/rich-text-essay-design.md): ?spacing=double — essay answers
   only, plain or formatted (line-height inherits into .essay-rich). */
.packet .answer-double { line-height: 2; }
.packet .choices, .packet .lines { list-style: none; padding: 0; margin: 0; }
.packet .choices li, .packet .lines li { margin: 0 0 .1rem; }
.packet .box { font-family: inherit; margin-right: .35rem; }
.packet table { border-collapse: collapse; width: 100%; margin-top: .4rem; }
.packet th, .packet td { border: 1px solid #000; padding: .2rem .35rem;
  text-align: left; vertical-align: top; }
.packet img { max-width: 100%; }
/* FB slice 3: the filled sentence in print ink — the underline marks each
   answer, the ✓ / ✗ glyphs and "expected" carry the result, not colour. */
.packet .fb-blank { border-bottom: 1px solid #000; }
.packet .fb-mark, .packet .fb-expected, .packet .fb-nokey, .packet .fb-summary,
  .packet .fb-unplaced { color: #000; opacity: 1; }
.packet .scores { margin-top: .5rem; display: grid; gap: .75rem;
  grid-template-columns: 1fr 1fr; break-inside: avoid; page-break-inside: avoid; }
.packet .scores-one { grid-template-columns: 1fr; }
.packet .score-block { border: 1px solid #000; padding: .4rem .5rem; }
/* FR D-1: every feedback block under its source's label, in print ink. The
   text is a teacher's or the AI's plain text: pre-line keeps its breaks. */
.packet .feedback-block { margin-top: .5rem; break-inside: avoid; page-break-inside: avoid; }
.packet .feedback-text { margin: 0; white-space: pre-line; }
.packet .feedback-criteria { margin: .15rem 0 0; padding-left: 1.25rem; }
.packet .page-footer { margin-top: 1.5rem; padding-top: .35rem;
  border-top: 1px solid #000; font-size: 9pt; color: #333; }
.packet .key-page table { width: auto; }
.packet .section-divider { margin: 0 0 .75rem; padding-bottom: .25rem; border-bottom: 2px solid #000;
  font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.strip { margin: 0 auto 1rem; max-width: 52rem; padding: 1rem 1.5rem 0;
  display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; }
/* Slice 2's toolbar: a plain GET form, screen only. */
.toolbar { margin: .5rem auto 1rem; max-width: 52rem; padding: 0 1.5rem;
  display: flex; flex-direction: column; gap: .6rem; }
.toolbar-items { display: flex; flex-wrap: wrap; gap: .15rem 1.25rem;
  border: 1px solid #ccc; border-radius: .375rem; padding: .5rem .75rem; }
.toolbar-items legend { padding: 0 .25rem; }
.toolbar-item { display: block; font-size: .85rem; white-space: nowrap; }
.toolbar-flag { display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem; }
.toolbar-scores { display: flex; flex-wrap: wrap; gap: .25rem 1rem;
  align-items: center; border: 1px solid #ccc; border-radius: .375rem; padding: .5rem .75rem; }
.toolbar-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.toolbar-students { border: 1px solid #ccc; border-radius: .375rem; padding: .5rem .75rem;
  display: flex; flex-wrap: wrap; gap: .5rem 2rem; }
.toolbar-student-group { display: flex; flex-direction: column; gap: .1rem; }
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

/**
 * A packet URL rebuilt from the current query, omitting whichever keys are
 * named — used by "Select all" to drop `?items=` while keeping every other
 * choice the teacher already made.
 */
function packetHref(
  assessmentId: string,
  query: PacketQuery,
  omit: ReadonlySet<"items"> = new Set(),
): string {
  const params = new URLSearchParams();
  for (const section of query.sections) params.append("section", section);
  for (const attempt of query.attempts) params.append("attempt", attempt);
  if (query.inProgress) params.set("in_progress", "1");
  if (!omit.has("items") && query.items) params.set("items", query.items.join(","));
  params.set("questions", query.questions ? "1" : "0");
  // FR slice 4: the boxes, never the legacy `scores=` — a rebuilt link that
  // kept it would carry the old mapping into every later click.
  for (const key of PACKET_CONTENT_KEYS) if (query.contents[key]) params.set(key, "1");
  if (query.teacherCopy) params.set("teacher_copy", "1");
  if (query.anon) params.set("anon", "1");
  if (query.doubleSpace) params.set("spacing", "double");
  if (!query.answers) params.set("answers", "0");
  return `/dashboard/${assessmentId}/results/work?${params.toString()}`;
}

/**
 * answerView's lines, with its ✓ / ✗ only when the packet shows the teacher's
 * side (`showKey`, hand-run 2026-09-14 finding W-1): a mark against the key is
 * the key, and a packet printed without the Teacher score box may leave the
 * teacher's hands (anonymous peer review, calibration).
 */
function AnswerLines({ lines, showKey }: { lines: AnswerLine[]; showKey: boolean }) {
  if (lines.length === 0) return <p className="meta muted">Nothing selected.</p>;
  return (
    <ul className="lines">
      {lines.map((line, i) => (
        <li key={i}>
          {showKey && line.correct !== null ? (
            <span>{line.correct ? "✓" : "✗"} </span>
          ) : null}
          {line.text}
        </li>
      ))}
    </ul>
  );
}

/** The per-student page's grid, in print ink: the student's cells, and the
 * key beside each only when the packet shows the teacher's side (W-1). */
function TableGrid({
  item,
  cells,
  showKey,
}: {
  item: ItemRow;
  cells: Record<string, Record<string, string>>;
  showKey: boolean;
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
                  {showKey && key !== undefined ? (
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

/**
 * One score block: its source's heading and the points, or "—" (teacher copy's
 * placeholder). In the teacher copy with the rubric table ticked it carries
 * its own row's levels and points (D-16, R-2), inside the block so whose they
 * are is never in doubt.
 */
function ScoreBlock({ block }: { block: PacketScoreBlock }) {
  return (
    <div className="score-block">
      <h3>{block.label}</h3>
      {block.row ? (
        <p className="meta">
          <strong>
            {block.row.points} / {block.row.max_points}
          </strong>
        </p>
      ) : (
        <p className="meta muted">—</p>
      )}
      {block.criteria.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Level</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            {block.criteria.map((c, i) => (
              <tr key={i}>
                <td>{c.criterion}</td>
                <td>{c.level}</td>
                <td>{c.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/**
 * A rubric table or a labelled feedback block from FR R-3's builder (the score
 * blocks go through ScoreBlock). Text is plain and prints as JSX text, never
 * as HTML: a teacher's comment is whatever they typed.
 */
function ReleaseBlock({ block }: { block: FeedbackBlock }) {
  if (block.kind === "score") return null;
  if (block.kind === "rubric_table") {
    const { columns } = block;
    return (
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            {columns.level ? <th>Level</th> : null}
            {columns.points ? <th>Points</th> : null}
            {columns.ai_feedback ? <th>AI feedback</th> : null}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>
              <td>{r.criterion}</td>
              {columns.level ? <td>{r.level ?? ""}</td> : null}
              {columns.points ? <td>{r.points ?? ""}</td> : null}
              {columns.ai_feedback ? <td>{r.ai_feedback ?? ""}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div className="feedback-block">
      <h3>{block.label}</h3>
      {block.text ? <p className="feedback-text">{block.text}</p> : null}
      {block.criteria.length > 0 ? (
        <ul className="feedback-criteria">
          {block.criteria.map((c, i) => (
            <li key={i}>
              <strong>{c.criterion}:</strong> <span className="feedback-text">{c.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
  // `view` and up (G-3); a caller without it gets the SAME answer as a missing row.
  const assessment = await pageAssessment(db, session, id, "view", "read");
  if (!assessment) {
    notFound();
  }

  // In-progress rows are read for `?attempt=` and the toolbar's student
  // picker only; every section count and the section packet itself use
  // `handedIn`, so an in-progress answer never reaches a class packet.
  // Practice attempts stay out (buildResults' default), as on every class
  // reader — the per-student page offers no print button for one.
  const results = await buildResults(id, { include_in_progress: true });
  const handedIn = results.rows.filter((r) => r.status === "submitted");

  // ── Who prints (docs/batch-print-design.md): one student, a batch of
  // section runs, or the chooser. A chosen attempt that is not this
  // assessment's finds nothing: the same notFound() as a missing assessment.
  const selection = selectPacket(results.rows, query);
  if (selection.kind === "not_found") {
    notFound();
  }
  const single = selection.kind === "single" ? selection.row : null;
  const runs: PacketRun<ResultsRow>[] =
    selection.kind === "single"
      ? [{ section: selection.row.student.section, rows: [selection.row], chosen: true }]
      : selection.kind === "batch"
        ? selection.runs
        : [];
  const multiRun = runs.length > 1;

  // Every section with at least one handed-in attempt, plus a count of
  // attempts that resolve to no section at all. Shared by the chooser below
  // (no `?section=`) and the toolbar's section `<select>` once one is picked.
  const sectionCounts = new Map<string, number>();
  let unsectioned = 0;
  for (const row of handedIn) {
    if (row.student.section) {
      sectionCounts.set(row.student.section, (sectionCounts.get(row.student.section) ?? 0) + 1);
    } else {
      unsectioned++;
    }
  }
  const sections = [...sectionCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // ── No section: the chooser. One URL per section is the contract, so rather
  // than printing "all sections" this lists what there is to print. Screen
  // only; there is nothing printable on this branch.
  if (selection.kind === "chooser") {
    return (
      <main className="mx-auto max-w-2xl space-y-4 px-6 py-10">
        <h1 className="text-2xl font-semibold">Print student work</h1>
        <p className="text-sm text-muted-foreground">
          Pick one or more sections — they print as one packet, a section at a
          time. {assessment.name}
        </p>
        {sections.length === 0 ? (
          <p className="text-sm">
            No handed-in work carries a section yet, so there is nothing to
            print. A section comes from the test session that named one, or
            from the student&apos;s enrollment in a section you teach.
          </p>
        ) : (
          // Batch print slice 2: a plain GET form, like the toolbar. Each name
          // stays a link to that section's packet alone (9.2).
          <form
            method="GET"
            action={`/dashboard/${assessment.id}/results/work`}
            className="space-y-3"
          >
            <ul className="space-y-2">
              {sections.map(([label, count]) => (
                <li key={label} className="flex items-baseline gap-2">
                  <input
                    type="checkbox"
                    name="section"
                    value={label}
                    aria-label={`Include ${label}`}
                  />
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
            <button type="submit" className="rounded-md border px-3 py-1.5 text-sm">
              Print selected
            </button>
          </form>
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

  const ordered = runs.flatMap((r) => r.rows);
  // D-2: anonymous labels numbered per section, over each section's
  // handed-in work, so a narrowed or single print keeps the number the full
  // section packet gives (James, 2026-09-23); work not handed in reads
  // "In progress n", as in the picker.
  const labels: Map<string, string> | null = query.anon
    ? new Map(
        runs.flatMap((run) => {
          const forSection = sectionAnonymousLabels(results.rows, run.section);
          return run.rows.map((r) => [r.attempt_id, forSection.get(r.attempt_id) ?? "Student"] as const);
        }),
      )
    : null;
  const handedInBySection = new Map<string | null, number>();
  for (const row of handedIn) {
    handedInBySection.set(row.student.section, (handedInBySection.get(row.student.section) ?? 0) + 1);
  }

  // "N of M students in <section> handed in": M is the section's current
  // enrollment, looked up in the sections the assessment's OWNER teaches
  // (a co-teacher or admin reading the packet gets the owner's count,
  // 2026-09-21) plus the sections its class sittings named — a co-teacher's
  // section counted 0 before (co-teacher follow-ups, 2026-09-22,
  // docs/access-model-design.md). Null when no owner email is known and no
  // sitting named the section, and the strip then says N alone. One per
  // whole-section run; a chosen-students run says how many were chosen.
  const enrolledBySection = new Map<string, number | null>();
  for (const run of runs) {
    if (single === null && !run.chosen && run.section !== null) {
      enrolledBySection.set(run.section, await sectionEnrolment(db, id, run.section));
    }
  }

  // Batch print slice 2: the toolbar's section and student checkboxes. The
  // ticked sections are the URL's, else the sections the packet's runs are in
  // (a single student's own section, or chosen students' sections).
  const tickedSections: (string | null)[] =
    query.sections.length > 0 ? query.sections : runs.map((r) => r.section);
  const tickedSectionSet = new Set(tickedSections);
  // Every section with handed-in work, plus any ticked one that has none yet
  // (a single in-progress student's, or a hand-edited URL's).
  const sectionOptions: [string, number][] = [
    ...sections,
    ...tickedSections
      .filter((s): s is string => s !== null && !sectionCounts.has(s))
      .map((s) => [s, 0] as [string, number]),
  ].sort((a, b) => a[0].localeCompare(b[0]));
  // Named, alphabetical — except in anonymous mode, where no name appears
  // anywhere above the key page (D-1), so each box carries the section
  // packet's label instead (handed in) or "In progress n".
  const choices = studentChoices(results.rows, tickedSections, query.anon);
  const chosenIds = new Set(query.attempts);
  const labelsBySection = new Map<string | null, Map<string, string>>();
  function pickerLabel(r: ResultsRow): string {
    if (query.anon) {
      let forSection = labelsBySection.get(r.student.section);
      if (!forSection) {
        forSection = sectionAnonymousLabels(results.rows, r.student.section);
        labelsBySection.set(r.student.section, forSection);
      }
      return forSection.get(r.attempt_id) ?? "Student";
    }
    const name = r.student.name || r.student.ssid || "(unknown)";
    return r.status === "in_progress" ? `${name} (in progress)` : name;
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
  // G-1: under the assessment's owner, with the assessment-scoped URL, so a
  // co-teacher's packet carries the owner's pictures.
  const resolvedAssets = await resolveAssessmentAssets(db, assessment, refs);

  // ── Responses and scores for this section's attempts only.
  const attemptIds = ordered.map((r) => r.attempt_id);
  const responseRows =
    attemptIds.length > 0
      ? await db.select().from(responses).where(inArray(responses.attempt_id, attemptIds))
      : [];
  const responseByCell = new Map(
    responseRows.map((r) => [`${r.attempt_id}:${r.item_id}`, r]),
  );

  // W-1 (hand-run 2026-09-14): the teacher's key — ✓ / ✗ on keyed lines and
  // the "expected" cell under a table — prints only with the teacher's side.
  const showKey = packetShowsKey(query.contents);
  const hideAnswers = packetHidesAnswers(query);
  const { contents } = query;
  // D-16: the teacher copy's levels print inside each score block
  // (packetScoreBlocks), so the builder's final-only rubric table is left out
  // there — beside an AI proposal it would print the teacher's levels under no
  // heading. With it off, the AI's per-criterion comments print as AI
  // feedback's labelled list instead (R-2).
  const builderContents = query.teacherCopy ? { ...contents, rubric_table: false } : contents;

  // FR slice 4: score rows feed the score boxes, AI feedback (the AI's own
  // row, D-10) and the rubric table's levels — any of them reads them.
  const needScores =
    contents.teacher_score || contents.ai_score || contents.ai_feedback || contents.rubric_table;
  const scoreRows =
    needScores && responseRows.length > 0
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

  // FR R-1 / D-4: the teacher's own comments, read only when that box is
  // ticked. Student-record content — printed here, never logged (D-14).
  const questionFeedback =
    contents.teacher_feedback && responseRows.length > 0
      ? await db
          .select({ response_id: response_feedback.response_id, text: response_feedback.text })
          .from(response_feedback)
          .where(
            inArray(
              response_feedback.response_id,
              responseRows.map((r) => r.id),
            ),
          )
      : [];
  const feedbackByResponse = new Map(questionFeedback.map((f) => [f.response_id, f.text]));
  const overallFeedback =
    contents.teacher_feedback && attemptIds.length > 0
      ? await db
          .select({ attempt_id: attempt_feedback.attempt_id, text: attempt_feedback.text })
          .from(attempt_feedback)
          .where(inArray(attempt_feedback.attempt_id, attemptIds))
      : [];
  const feedbackByAttempt = new Map(overallFeedback.map((f) => [f.attempt_id, f.text]));

  function identityLine(row: ResultsRow): string {
    if (labels) return labels.get(row.attempt_id) ?? "Student";
    return [row.student.name, row.student.student_number].filter(Boolean).join(" · ");
  }

  const printedOn = formatDate(new Date());

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="strip screen-only">
        <button type="button" data-print className="rounded-md border px-3 py-1.5 text-sm">
          Print / Save as PDF
        </button>
        <span className="text-sm">
          {single
            ? single.status === "in_progress"
              ? "One student's work — in progress, not handed in"
              : "One student's work — handed in"
            : runs.map((run) => (
                <span key={run.section ?? "__none__"} className="block">
                  {stripLine(run, run.section === null ? null : (enrolledBySection.get(run.section) ?? null), multiRun)}
                </span>
              ))}
        </span>
        <a
          href={`/dashboard/${assessment.id}/results`}
          className="text-sm underline"
        >
          Back to results
        </a>
      </div>
      {/* The toolbar: a plain GET form back to this same route, so the whole
          packet stays a bookmarkable link and nothing here needs client JS.
          "Select all" links rather than a JS-driven checkbox, and there is no
          "Select none" — an empty packet is not a useful print, so the design
          note's alternative (a link with no items) is skipped; see
          docs/student-work-export-design.md §Progress for this deviation. */}
      <form
        method="GET"
        action={`/dashboard/${assessment.id}/results/work`}
        className="toolbar screen-only"
      >
        <fieldset className="toolbar-items">
          <legend>Sections</legend>
          {sectionOptions.map(([label, count]) => (
            <label key={label} className="toolbar-item">
              <input
                type="checkbox"
                name="section"
                value={label}
                defaultChecked={tickedSectionSet.has(label)}
              />{" "}
              {label} ({count} handed in)
            </label>
          ))}
        </fieldset>
        <fieldset className="toolbar-students">
          {/* None ticked = everyone in the ticked sections. The list follows
              the ticked sections after Update — a GET round trip, no JS. */}
          <legend>Students (none ticked = everyone in the sections above)</legend>
          {choices.tooMany ? (
            <p className="meta" role="status">
              Too many students to choose one by one ({choices.count}) — choose
              sections instead.
            </p>
          ) : (
            choices.groups.map((group) => (
              <div key={group.section ?? "__none__"} className="toolbar-student-group">
                <p className="meta">{group.section ?? "No section"}</p>
                {group.rows.map((r) => (
                  <label key={r.attempt_id} className="toolbar-item">
                    <input
                      type="checkbox"
                      name="attempt"
                      value={r.attempt_id}
                      defaultChecked={chosenIds.has(r.attempt_id)}
                    />{" "}
                    {pickerLabel(r)}
                  </label>
                ))}
              </div>
            ))
          )}
        </fieldset>
        <label className="toolbar-flag">
          {/* D-3: off by default, so an unchecked box (which submits nothing)
              is the default — no hidden field needed. */}
          <input
            type="checkbox"
            name="in_progress"
            value="1"
            defaultChecked={query.inProgress}
          />
          Include work not yet handed in
        </label>
        <fieldset className="toolbar-items">
          <legend>
            Questions to include{" "}
            <a href={packetHref(assessment.id, query, new Set(["items"]))}>Select all</a>
          </legend>
          {allItems.map((item) => (
            <label key={item.id} className="toolbar-item">
              <input
                type="checkbox"
                name="items"
                value={item.id}
                defaultChecked={
                  query.items === null || query.items.includes(item.id.toLowerCase())
                }
              />{" "}
              Q{item.position + 1} — {stemExcerpt(item.stem)}
            </label>
          ))}
        </fieldset>
        <label className="toolbar-flag">
          {/* The hidden field submits `0` when the box is unchecked (an
              unchecked checkbox submits nothing at all); when checked, the
              box's own `1` follows it in the query string and wins —
              parsePacketQuery reads the LAST `questions` value. */}
          <input type="hidden" name="questions" value="0" />
          <input type="checkbox" name="questions" value="1" defaultChecked={query.questions} />
          Show questions (stems, choices, stimulus)
        </label>
        <fieldset className="toolbar-scores">
          {/* FR D-7: the Doc dialog's boxes and labels (CONTENT_OPTIONS), less
              prompt and sources. Each is off by default, so an unchecked box
              (which submits nothing) is the default — no hidden field. */}
          <legend>Scores and feedback</legend>
          {CONTENT_OPTIONS.filter((o) =>
            (PACKET_CONTENT_KEYS as readonly string[]).includes(o.key),
          ).map((o) => (
            <label key={o.key} className="toolbar-flag">
              <input
                type="checkbox"
                name={o.key}
                value="1"
                defaultChecked={query.contents[o.key as (typeof PACKET_CONTENT_KEYS)[number]]}
              />{" "}
              {o.label}
            </label>
          ))}
          <label className="toolbar-flag">
            {/* FR D-16: off by default — the student copy, where an AI score
                the teacher overrode never prints. */}
            <input type="checkbox" name="teacher_copy" value="1" defaultChecked={query.teacherCopy} />{" "}
            Teacher copy (shows the AI's proposal even where you changed it — not for students)
          </label>
        </fieldset>
        <label className="toolbar-flag">
          <input type="checkbox" name="anon" value="1" defaultChecked={query.anon} />
          Anonymous (labels + key page)
        </label>
        <label className="toolbar-flag">
          {/* RT D-10: off by default, so an unchecked box (which submits
              nothing) is the default single spacing — no hidden field needed. */}
          <input
            type="checkbox"
            name="spacing"
            value="double"
            defaultChecked={query.doubleSpace}
          />
          Double-space essays
        </label>
        <label className="toolbar-flag">
          {/* U-23: on by default, so the box submits `answers=0` only when
              checked — no hidden field. */}
          <input type="checkbox" name="answers" value="0" defaultChecked={!query.answers} />
          Leave out answers (scores and feedback only)
        </label>
        {!query.answers && !packetPrintsBlocks(contents) ? (
          <p className="meta" role="status">
            Leaving out answers needs a score or feedback box ticked above —
            answers are printed until you tick one.
          </p>
        ) : null}
        <button type="submit" className="rounded-md border px-3 py-1.5 text-sm self-start">
          Update
        </button>
      </form>
      <main className="packet">
        {runs.map((run) => (
          <Fragment key={run.section ?? "__none__"}>
            {run.rows.length === 0 ? (
              <p className="meta">
                Nobody in {run.section} has handed this in yet, so there is nothing to
                print.
              </p>
            ) : null}

            {run.rows.map((row, i) => {
              // FR R-3: the same builder as the Doc, so a box means the same
              // thing in both outputs. One question per included item.
              const rowsFor = (item: ItemRow): ScoreRow[] => {
                const resp = responseByCell.get(`${row.attempt_id}:${item.id}`);
                return resp ? (scoresByResponse.get(resp.id) ?? []) : [];
              };
              const rubricFor = (item: ItemRow) => questionRubric(item.config.rubric, rowsFor(item));
              const release = buildFeedbackRelease(builderContents, {
                questions: includedItems.map((item) => {
                  const resp = responseByCell.get(`${row.attempt_id}:${item.id}`);
                  const rowsHere = rowsFor(item);
                  return {
                    rubric: rubricFor(item),
                    scores: rowsHere,
                    // Never `rationale.note` (a score-change reason, R-1).
                    teacher_feedback: resp ? (feedbackByResponse.get(resp.id) ?? null) : null,
                    // D-10: an AI row older than the answer's last edit is
                    // about the answer before a pass back.
                    answer_updated_at: resp ? resp.updated_at : null,
                    // A short answer's AI comments can state its key: left out
                    // of the student copy, kept in the teacher copy (D-16).
                    withhold_ai_feedback: item.type === "short_text" && !query.teacherCopy,
                  };
                }),
                overall_teacher_feedback: feedbackByAttempt.get(row.attempt_id) ?? null,
              });
              return (
                <section
                  key={row.attempt_id}
                  className="student-page"
                  aria-label={
                    labels
                      ? `Work for ${labels.get(row.attempt_id)}`
                      : `Work for ${row.student.name}`
                  }
                >
                  {/* Batch print: a divider on the first page of each section's
                      run, so a stack can be split by hand. A one-section packet
                      prints as before. */}
                  {multiRun && i === 0 ? (
                    <p className="section-divider">{run.section ?? "No section"}</p>
                  ) : null}
                  <h2>{identityLine(row)}</h2>
                  <p className="meta">
                    {[run.section, assessment.name].filter(Boolean).join(" · ")}
                  </p>
                  {/* Printed, not screen-only: the paper itself has to say these
                      answers were not handed in (only `?attempt=` reaches here). */}
                  {row.status === "in_progress" ? (
                    <p className="meta">
                      <strong>In progress — not handed in</strong> · answers saved so far
                    </p>
                  ) : (
                    <p className="meta muted">Handed in {printWhen(row.submitted_at)}</p>
                  )}
                  {/* FR D-16: the teacher copy prints AI proposals D-3/D-17 keep
                      from students, so the paper itself says who it is for —
                      like the key page's "do not distribute". */}
                  {query.teacherCopy ? (
                    <p className="meta">
                      <strong>Teacher copy — not for students</strong>
                    </p>
                  ) : null}
                  {/* FR D-4: the overall comment, once, above the questions. */}
                  {release.overall ? <ReleaseBlock block={release.overall} /> : null}

                  {includedItems.map((item, itemIndex) => {
                    const setId = setOpensAtItem.get(item.id);
                    const set = setId ? setsById.get(setId)! : null;
                    const response = responseByCell.get(`${row.attempt_id}:${item.id}`);
                    const responseJson = response
                      ? (response.response as unknown as Record<string, unknown>)
                      : null;
                    const view = describeAnswer(
                      {
                        type: item.type,
                        stem: item.stem,
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
                    const blocks = release.questions[itemIndex] ?? [];
                    // Student copy: the builder's score block (D-3, D-13, D-17);
                    // teacher copy: today's, each with its own levels (D-16).
                    const scoreBlocks = packetScoreBlocks(
                      contents,
                      query.teacherCopy,
                      rowsFor(item),
                      blocks,
                      rubricFor(item),
                    );
                    const otherBlocks = blocks.filter((b) => b.kind !== "score");
                    // U-23: a hidden answer has nothing to paginate.
                    const isText = view.kind === "text" && !hideAnswers;
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
                          {/* FB slice 3: with the questions printed, a
                              fill-in-the-blank stem is printed ONCE, as the sentence
                              with the student's answers in place
                              (renderFillBlankAnswerHtml: stem through
                              renderItemContent, answers escaped). Marks and
                              "expected" only with the teacher's side (W-1). An
                              answers-only packet prints the "Blank n: …" lines
                              below instead. */}
                          {query.questions && item.type === "fill_blank" && hideAnswers ? (
                            <div
                              className="stem"
                              dangerouslySetInnerHTML={{
                                __html: renderFillBlankGapsHtml(item.stem, resolvedAssets),
                              }}
                            />
                          ) : query.questions && item.type === "fill_blank" ? (
                            <div
                              className="stem"
                              dangerouslySetInnerHTML={{
                                __html: renderFillBlankAnswerHtml(
                                  item.stem,
                                  item.config.blanks,
                                  responseJson,
                                  resolvedAssets,
                                  { showKey, summary: showKey && responseJson != null, handScored: fillBlankHandScored(item.config) },
                                ),
                              }}
                            />
                          ) : query.questions ? (
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
                              src={assessmentAssetUrl(assessment.id, item.config.image_asset_id)}
                              alt={`Picture for question ${item.position + 1}`}
                            />
                          ) : null}

                          {/* U-23: answers=0 — the choices still print for
                              context (no ticks), nothing the student wrote does. */}
                          {hideAnswers ? (
                            boxes.length > 0 ? (
                              <ul className="choices">
                                {boxes.map((b) => (
                                  <li key={b.id}>{b.text}</li>
                                ))}
                              </ul>
                            ) : null
                          ) : (
                          <div className="answer">
                            {view.kind === "none" ? (
                              <p className="meta muted">No answer.</p>
                            ) : isText && view.kind === "text" ? (
                              // Roadmap 4b-f (2026-09-14): a short-text answer
                              // prints as the math the student saw (the client's
                              // formulaTex preview), essays as prose.
                              item.type === "short_text" && view.text !== "" ? (
                                <p
                                  className="answer-text"
                                  dangerouslySetInnerHTML={{
                                    __html: renderShortTextAnswer(view.text),
                                  }}
                                />
                              ) : item.type === "essay" ? (
                                // RT slice 2 (docs/rich-text-essay-design.md): the
                                // one sanitising renderer — a formatted essay keeps
                                // its formatting, a plain one is its escaped text
                                // (pre-line keeps the line breaks). A div, since the
                                // formatted form holds paragraphs and lists. D-10:
                                // ?spacing=double double-spaces it.
                                view.text === "" ? (
                                  <div
                                    className={`answer-text${query.doubleSpace ? " answer-double" : ""}`}
                                  >
                                    (blank)
                                  </div>
                                ) : (
                                  <div
                                    className={`answer-text${query.doubleSpace ? " answer-double" : ""}`}
                                    dangerouslySetInnerHTML={{
                                      __html: renderEssayAnswerHtml(responseJson),
                                    }}
                                  />
                                )
                              ) : (
                                <p className="answer-text">
                                  {view.text === "" ? "(blank)" : view.text}
                                </p>
                              )
                            ) : boxes.length > 0 ? (
                              <ul className="choices">
                                {boxes.map((b) => (
                                  <li key={b.id}>
                                    <span className="box">{b.selected ? "☑" : "☐"}</span>
                                    {/* WP-2: choice text follows the stem's content
                                        rules (KaTeX, emphasis, `![alt](asset:…)`);
                                        it printed raw until 2026-10-18. */}
                                    <span
                                      className="choice-text"
                                      dangerouslySetInnerHTML={{
                                        __html: renderItemContent(b.text, resolvedAssets),
                                      }}
                                    />
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
                                showKey={showKey}
                              />
                            ) : view.kind === "lines" ? (
                              <AnswerLines lines={view.lines} showKey={showKey} />
                            ) : view.kind === "fill_blank" && !query.questions ? (
                              <AnswerLines lines={view.lines} showKey={showKey} />
                            ) : null}
                          </div>
                          )}

                          {scoreBlocks.length > 0 ? (
                            // Two columns only while two blocks both have a score
                            // (teacher copy): one lonely block in a half-width
                            // column reads as a rendering bug.
                            <div
                              className={
                                scoreBlocks.length === 2 && scoreBlocks.every((b) => b.row)
                                  ? "scores"
                                  : "scores scores-one"
                              }
                            >
                              {scoreBlocks.map((b, bi) => (
                                <ScoreBlock key={bi} block={b} />
                              ))}
                            </div>
                          ) : null}
                          {/* FR R-2 / D-10 / D-4: the rubric table, AI feedback
                              and teacher feedback, each labelled (D-1). */}
                          {otherBlocks.map((b, bi) => (
                            <ReleaseBlock key={bi} block={b} />
                          ))}
                        </div>
                      </div>
                    );
                  })}

                  {/* Page numbers are the browser's; this is the identity line that
                      gets a loose annotated sheet back to the right student. */}
                  <p className="page-footer">
                    {/* D-2: "Student 01" repeats once per section in a batch, so
                        the footer names the section beside it. */}
                    {[
                      assessment.name,
                      multiRun ? run.section : null,
                      identityLine(row),
                      query.teacherCopy ? "Teacher copy" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </section>
              );
            })}

            {/* D-1 / D-2: a key page closes each section's run, so each
                section's stack tears off on its own. */}
            {labels && run.rows.length > 0 ? (
              <section className="student-page key-page" aria-label="Teacher key">
                <h2>Teacher key — do not distribute</h2>
                <p className="meta">
                  {[assessment.name, run.section].filter(Boolean).join(" · ")}
                </p>
                {single ? (
                  // One student printed alone: the label is the section packet's
                  // (or "In progress n"), as of this print.
                  <p className="meta">Printed {printedOn} · one student&apos;s work</p>
                ) : (
                  <>
                    <p className="meta">Printed {printedOn} · {keyCountLine(run)}</p>
                    <p className="meta muted">
                      Labels are assigned over the {handedInBySection.get(run.section) ?? 0} attempt
                      {(handedInBySection.get(run.section) ?? 0) === 1 ? "" : "s"} handed in as of this
                      print. If another student hands in and you print again, the labels can shift —
                      keep this page with its packet.
                    </p>
                  </>
                )}
                <table>
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Student</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.rows.map((row) => (
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
          </Fragment>
        ))}
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
