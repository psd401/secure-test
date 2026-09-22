import Link from "next/link";
import { DeleteAttemptAndReturn } from "./DeleteAttemptAndReturn";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  assets,
  attempt_events,
  attempts,
  items,
  responses,
  scores,
  type ItemRow,
  type ScoreRow,
} from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";
import {
  renderItemContent,
  type ResolvedAsset,
} from "@/lib/items/renderItemContent";
import { describeAnswer, type AnswerLine } from "@/lib/reporting/answerView";
import { renderShortTextAnswer } from "@/lib/reporting/shortTextView";
import {
  overallRationale,
  rubricScoreRows,
  type RubricScoreRow,
} from "@/lib/reporting/rubricScoreView";
import { buildTimeline } from "@/lib/reporting/timeline";
import { tableCellMatches } from "@/lib/scoring/auto";
import { buildResults, itemMaxPoints } from "@/lib/scoring/results";
import { listSupersededScores } from "@/lib/scoring/supersededScores";
import { formatWhen } from "@/lib/ui/format";
import { UUID_RE } from "@/lib/uuid";
import { pageAssessment } from "@/lib/api/access";
import { deadlineNote } from "../../attendanceView";
import { ExtendTimeAndReload } from "../ExtendTimeAndReload";
import { HandInAttemptAndReload } from "../HandInAttemptAndReload";
import { PassBackAndReload } from "../PassBackAndReload";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; attemptId: string }>;
}

const METHOD_WORD: Record<string, string> = {
  auto: "auto-scored",
  ai: "AI, approved by you",
  human: "scored by you",
};

/**
 * The one final score per response, and the newest proposal, split out.
 *
 * Pass back (docs/pass-back-design.md): a `superseded` row is deliberately
 * NOT a candidate for `proposed` — before this fix, the "newest non-final
 * row" test picked up a just-superseded score as if it were an unapproved AI
 * proposal, which would have shown "AI proposal: … (not counted)" for a
 * number that was in fact once the student's real final score. Superseded
 * rows appear only in the "Earlier scores" section below, via
 * `listSupersededScores`.
 */
function splitScores(rows: ScoreRow[]): {
  final: ScoreRow | null;
  proposed: ScoreRow | null;
} {
  let final: ScoreRow | null = null;
  let proposed: ScoreRow | null = null;
  for (const row of rows) {
    if (row.status === "final") final = row;
    else if (
      row.status === "proposed" &&
      (!proposed || row.created_at >= proposed.created_at)
    ) {
      proposed = row;
    }
  }
  return { final, proposed };
}

/**
 * D-6: the per-criterion reading of a rubric score — the chosen level and
 * its rationale — above the overall rationale, for FINAL and PROPOSED
 * scores alike (the teacher is reviewing, not publishing). Rows come from
 * `rubricScoreRows` so slice 5's print page renders the same reading.
 */
function RubricScoreDetail({
  rows,
  overall,
}: {
  rows: RubricScoreRow[];
  overall: string | null;
}) {
  if (rows.length === 0) {
    return overall ? (
      <p className="mt-1 text-xs text-muted-foreground">{overall}</p>
    ) : null;
  }
  const cell = "border border-border px-2 py-1 align-top text-xs";
  return (
    <div className="mt-2">
      <div className="overflow-x-auto">
        <table className="min-w-max border-collapse">
          <thead>
            <tr>
              <th className={`${cell} bg-muted text-left font-medium`}>
                Criterion
              </th>
              <th className={`${cell} bg-muted text-left font-medium`}>
                Level
              </th>
              <th className={`${cell} bg-muted text-left font-medium`}>
                Points
              </th>
              <th className={`${cell} bg-muted text-left font-medium`}>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.criterion_id}>
                <td className={cell}>{r.criterion_name}</td>
                <td className={cell}>{r.level_label}</td>
                <td className={cell}>{r.points}</td>
                <td className={`${cell} text-muted-foreground`}>
                  {r.rationale ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {overall ? (
        <p className="mt-1 text-xs text-muted-foreground">{overall}</p>
      ) : null}
    </div>
  );
}

function AnswerLines({ lines }: { lines: AnswerLine[] }) {
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing selected.</p>;
  }
  return (
    <ul className="space-y-1">
      {lines.map((line, i) => (
        <li key={i} className="text-sm">
          {line.correct === null ? null : (
            <span
              className={
                line.correct ? "text-success-foreground" : "text-destructive"
              }
              title={
                line.correct ? "Matches the key" : "Does not match the key"
              }
            >
              {line.correct ? "✓" : "✗"}{" "}
            </span>
          )}
          {line.text}
        </li>
      ))}
    </ul>
  );
}

/** The queue's grid, server-rendered: the student's cells with the key beside them. */
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
  const th =
    "border border-border bg-muted px-2 py-1 text-left text-xs font-medium";
  return (
    <div className="overflow-x-auto">
      <table className="min-w-max border-collapse text-sm">
        <thead>
          <tr>
            {showLabels ? (
              <th className={th}>{item.config.corner ?? ""}</th>
            ) : null}
            {columns.map((c) => (
              <th key={c.id} className={th}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {showLabels ? <th className={th}>{r.label}</th> : null}
              {columns.map((c) => {
                const answer = cells[r.id]?.[c.id];
                const key = keys[r.id]?.[c.id];
                const ok =
                  key !== undefined
                    ? tableCellMatches(answer ?? "", key)
                    : null;
                return (
                  <td
                    key={c.id}
                    className="border border-border px-2 py-1 align-top"
                  >
                    <div>
                      {answer !== undefined && answer !== "" ? (
                        answer
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                    {key !== undefined ? (
                      <div
                        className={`text-xs ${ok ? "text-success-foreground" : "text-destructive"}`}
                      >
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
    </div>
  );
}

/**
 * R1 (docs/reporting-design.md): one student's whole attempt on one page —
 * every item in order with what they answered, what it scored and who
 * scored it, plus the integrity timeline built from `attempt_events`.
 *
 * D-R5: owner-only, and the only door to it is the results matrix. An
 * attempt that is not this assessment's, or an assessment that is not this
 * teacher's, is `notFound()` — a report about a named child does not get a
 * distinguishing error.
 *
 * Identity, totals and the section label are `buildResults`' — the same
 * numbers the matrix shows, from one code path, so a per-student page can
 * never disagree with the row it was opened from.
 *
 * Time limit / unfinished attempts (D-1/B): `include_in_progress` means an
 * IN-PROGRESS attempt no longer 404s here — it renders with a "Not handed
 * in" badge, the answered count, every saved answer (no score section, since
 * nothing has been scored), and a Hand-in control beside Delete.
 */
export default async function AttemptResultPage({ params }: PageProps) {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard");
  }
  const { id, attemptId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(attemptId)) {
    notFound();
  }

  const db = getDb();
  const assessment = await pageAssessment(db, session, id, "view");
  if (!assessment) {
    notFound();
  }

  const [attempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.assessment_id, id)))
    .limit(1);
  if (!attempt) {
    notFound();
  }

  const results = await buildResults(id, {
    include_in_progress: true,
    // Practice (docs/practice-sitting-design.md, D-4): the one reader that
    // DOES show a practice attempt — reached only from the practice row, so
    // a teacher can read back their own answers and the integrity timeline.
    include_practice: true,
  });
  const row = results.rows.find((r) => r.attempt_id === attemptId);
  if (!row) {
    notFound();
  }

  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));

  // Stems reach this page rendered — math as KaTeX, image refs owner-scoped —
  // the same resolution the review queue does, for the same reason: a teacher
  // reading a student's answer should see the question as the student saw it.
  const stemRefs = extractAssetRefsFromMany(itemRows.map((i) => i.stem));
  const resolvedAssets = new Map<string, ResolvedAsset>();
  if (stemRefs.length > 0) {
    const assetRows = await db
      .select({ id: assets.id, content_type: assets.content_type })
      .from(assets)
      .where(
        and(eq(assets.owner_sub, session.sub), inArray(assets.id, stemRefs)),
      );
    for (const a of assetRows) {
      resolvedAssets.set(a.id.toLowerCase(), {
        id: a.id,
        content_type: a.content_type,
      });
    }
  }

  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.attempt_id, attemptId));
  const responseByItem = new Map(responseRows.map((r) => [r.item_id, r]));

  const scoreRows =
    responseRows.length > 0
      ? await db
          .select()
          .from(scores)
          .where(
            // This page lists every score row per response; research rows
            // are excluded (docs/scoring-corpus-design.md slice 1).
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

  // Pass back (docs/pass-back-design.md): k in "Their k scores are kept as a
  // record…" — the CURRENT final scores, i.e. the ones a pass back right now
  // would supersede. `listSupersededScores` is a separate read of the same
  // table, scoped to `status = 'superseded'` — the history of every earlier
  // pass back, oldest first, for the collapsed section below.
  const finalScoreCount = scoreRows.filter((s) => s.status === "final").length;
  const supersededScores = await listSupersededScores(db, attemptId);
  const itemLabelById = new Map(
    itemRows.map((item) => [item.id, `Q${item.position + 1}`] as const),
  );

  const eventRows = await db
    .select()
    .from(attempt_events)
    .where(eq(attempt_events.attempt_id, attemptId))
    .orderBy(asc(attempt_events.at));
  const timeline = buildTimeline(
    eventRows.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind,
      detail: e.detail,
    })),
  );

  const identity = [row.student.student_number, row.student.section]
    .filter(Boolean)
    .join(" · ");

  // Pass back (docs/pass-back-design.md): the same "does a deadline exist at
  // all" test the route applies, asked here so the dialog knows up front
  // whether to ask for a new one.
  const timed =
    (assessment.time_limit_seconds ?? 0) > 0 ||
    attempt.deadline_override_at !== null;

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-10">
      <div>
        <Link
          href={`/dashboard/${id}/results`}
          className="text-sm text-muted-foreground underline"
        >
          ← Back to results
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {row.student.name || row.student.ssid || "(unknown)"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {identity ? `${identity} · ` : ""}
          {assessment.name}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {row.status === "in_progress" ? (
            <p className="text-sm">
              <span className="font-medium text-warning-foreground">
                Not handed in
              </span>{" "}
              · Started{" "}
              {attempt.started_at ? formatWhen(attempt.started_at) : "—"} ·{" "}
              {row.answered_count} of {results.items.length} answered
              {/* Pass back (docs/pass-back-design.md): the header names how
                  many times this attempt has been passed back, so the
                  "in progress" status doesn't read as a plain, never-touched
                  first sitting. */}
              {attempt.pass_back_count > 0 ? (
                <>
                  {" "}
                  · passed back {attempt.pass_back_count} time
                  {attempt.pass_back_count === 1 ? "" : "s"}
                </>
              ) : null}
              {deadlineNote(row.deadline_at, row.deadline_passed) ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {deadlineNote(row.deadline_at, row.deadline_passed)}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm">
              Handed in {row.submitted_at ? formatWhen(row.submitted_at) : "—"}{" "}
              ·{" "}
              <strong>
                {row.total_points} / {row.max_points}
              </strong>{" "}
              ·{" "}
              {row.unscored_count === 0
                ? `${row.percent ?? 0}%`
                : `${row.unscored_count} unscored`}
              {/* Time limit / unfinished attempts (D-1/A): who ended this
                  attempt, next to when. */}
              {row.submitted_by_sub ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  Handed in by teacher
                </span>
              ) : null}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {row.status === "in_progress" ? (
              <HandInAttemptAndReload
                attemptId={attemptId}
                studentName={
                  row.student.name || row.student.ssid || "this student"
                }
                answeredCount={row.answered_count}
                disabledReason={
                  row.sitting_open && !row.deadline_passed
                    ? "End the test session first, then hand in."
                    : undefined
                }
              />
            ) : null}
            {row.status === "in_progress" ? (
              <ExtendTimeAndReload attemptId={attemptId} />
            ) : null}
            {row.status === "submitted" ? (
              <PassBackAndReload
                attemptId={attemptId}
                studentName={
                  row.student.name || row.student.ssid || "this student"
                }
                scoreCount={finalScoreCount}
                timed={timed}
              />
            ) : null}
            <DeleteAttemptAndReturn
              attemptId={attemptId}
              assessmentId={id}
              studentName={
                row.student.name || row.student.ssid || "this student"
              }
              disabledReason={
                row.status === "in_progress" && row.sitting_open
                  ? "End the test session first, then delete."
                  : undefined
              }
            />
          </div>
        </div>
      </div>

      <section aria-labelledby="answers" className="space-y-4">
        <h2 id="answers" className="text-lg font-semibold">
          Answers
        </h2>
        {itemRows.map((item) => {
          const response = responseByItem.get(item.id);
          const view = describeAnswer(
            {
              type: item.type,
              choices: item.choices as Array<{ id: string; text: string }>,
              correct_choice_ids: item.correct_choice_ids as string[],
              correct_answer: item.correct_answer,
              config: item.config,
            },
            response
              ? (response.response as unknown as Record<string, unknown>)
              : null,
          );
          const { final, proposed } = splitScores(
            response ? (scoresByResponse.get(response.id) ?? []) : [],
          );
          const rubric = item.config.rubric ?? null;
          const finalDetail = {
            rows: rubricScoreRows(rubric, final?.rationale),
            overall: overallRationale(final?.rationale),
          };
          const proposedDetail = {
            rows: rubricScoreRows(rubric, proposed?.rationale),
            overall: overallRationale(proposed?.rationale),
          };
          return (
            <article
              key={item.id}
              className="rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  Q{item.position + 1}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.type}
                </span>
              </div>
              {/* stem_html is server-rendered by renderItemContent: text is
                  HTML-escaped, math is KaTeX, image refs resolve owner-scoped
                  or come back as inline-red placeholders — no injection vector. */}
              <div
                className="mt-1 whitespace-pre-line text-sm"
                dangerouslySetInnerHTML={{
                  __html: renderItemContent(item.stem, resolvedAssets),
                }}
              />

              <div className="mt-3">
                {view.kind === "none" ? (
                  <p className="text-sm text-muted-foreground">No answer.</p>
                ) : view.kind === "text" ? (
                  <>
                    {/* Roadmap 4b-f (2026-09-14): a short-text answer is math
                        on the student's screen (the client's formulaTex
                        preview), so it is math here too — same tex, KaTeX
                        server-side, escaped plain text when it doesn't parse.
                        Essays stay prose. */}
                    {item.type === "short_text" && view.text !== "" ? (
                      <blockquote
                        className="whitespace-pre-wrap rounded bg-muted p-2 text-sm"
                        dangerouslySetInnerHTML={{
                          __html: renderShortTextAnswer(view.text),
                        }}
                      />
                    ) : (
                      <blockquote className="whitespace-pre-wrap rounded bg-muted p-2 text-sm">
                        {view.text === "" ? "(blank)" : view.text}
                      </blockquote>
                    )}
                    {view.expected ? (
                      item.type === "short_text" ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Expected:{" "}
                          <span
                            dangerouslySetInnerHTML={{
                              __html: renderShortTextAnswer(view.expected),
                            }}
                          />
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Expected: {view.expected}
                        </p>
                      )
                    ) : null}
                  </>
                ) : view.kind === "drawing" && response ? (
                  // R0.2 / F-1: the bytes come from the owner-scoped upload
                  // route. Full size here — the queue caps its height, this
                  // page is where the teacher actually reads the drawing.
                  <img
                    src={`/api/responses/${response.id}/upload`}
                    alt={`Drawing for question ${item.position + 1}`}
                    className="max-w-full rounded border border-border"
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

              {/* Time limit / unfinished attempts (D-1/B): an in-progress
                  attempt has nothing scored — auto-scoring runs on hand-in —
                  so this whole section is a no-op noise floor until then. */}
              {row.status === "in_progress" ? null : (
                <div className="mt-3 border-t border-border pt-2 text-sm">
                  {final ? (
                    <p>
                      <strong>
                        {final.points} / {final.max_points}
                      </strong>{" "}
                      <span className="text-muted-foreground">
                        ({METHOD_WORD[final.method] ?? final.method})
                      </span>
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      Not scored yet ({itemMaxPoints(item)} point
                      {itemMaxPoints(item) === 1 ? "" : "s"} available)
                    </p>
                  )}
                  {final ? (
                    <RubricScoreDetail
                      rows={finalDetail.rows}
                      overall={finalDetail.overall}
                    />
                  ) : null}
                  {proposed && !final ? (
                    // Never counted, and the page says so in the same breath
                    // as the number so it cannot be read as a score.
                    <p className="mt-1 text-xs">
                      AI proposal: {proposed.points} / {proposed.max_points}{" "}
                      (not counted)
                    </p>
                  ) : null}
                  {proposed && !final ? (
                    <RubricScoreDetail
                      rows={proposedDetail.rows}
                      overall={proposedDetail.overall}
                    />
                  ) : null}
                </div>
              )}
            </article>
          );
        })}
      </section>

      {/* Pass back (docs/pass-back-design.md, D-2): the scores this attempt
          was given before it was passed back — kept as a record, out of the
          main answers list so they can never be mistaken for the current
          score. Collapsed by default; only rendered once there is history. */}
      {supersededScores.length > 0 ? (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Earlier scores (before pass back)
          </summary>
          <ul className="mt-3 space-y-1 text-sm">
            {supersededScores.map((s, i) => (
              <li key={i} className="text-muted-foreground">
                {itemLabelById.get(s.item_id) ?? "—"}:{" "}
                <span className="text-foreground">
                  {s.points} / {s.max}
                </span>{" "}
                ({METHOD_WORD[s.method] ?? s.method}) ·{" "}
                {formatWhen(s.created_at)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section aria-labelledby="timeline" className="space-y-2">
        <h2 id="timeline" className="text-lg font-semibold">
          Test session history
        </h2>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to report — this attempt sent no session events.
          </p>
        ) : (
          <ol className="space-y-1">
            {timeline.map((line, i) => (
              <li key={i} className="text-sm">
                {line.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
