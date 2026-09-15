// Slice 2 of docs/scoring-corpus-design.md: read one or more corpus runs and
// report how each compares to the teacher's finals.
//
//   bun --env-file=.env.local scripts/compare-runs.ts --run "<label>" [--run "<label>"] [--csv]
//   bun --env-file=.env.local scripts/compare-runs.ts --all [--csv]
//
// Default output is a readable table; --csv writes one CSV row per run to
// stdout. Response / item ids only — no student identifier is read or printed.
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { responses, scores, scoring_runs } from "../db/schema";
import {
  comparisonToCsv,
  compareRun,
  type ComparisonPair,
  type RunComparison,
} from "../lib/reporting/runComparison";

const USAGE =
  'usage: bun scripts/compare-runs.ts (--run "<label>" [--run …] | --all) [--csv]';

const labels: string[] = [];
let all = false;
let csv = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "--all") all = true;
  else if (arg === "--csv") csv = true;
  else if (arg === "--run") {
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      console.error("--run needs a label");
      process.exit(2);
    }
    labels.push(value);
  } else {
    console.error(`unknown argument "${arg}"`);
    console.error(USAGE);
    process.exit(2);
  }
}
if (all === (labels.length > 0)) {
  console.error(all ? "--all and --run are mutually exclusive" : USAGE);
  process.exit(2);
}

const db = getDb();

async function main(): Promise<number> {
  const runRows = all
    ? await db.select().from(scoring_runs).orderBy(scoring_runs.created_at)
    : await db.select().from(scoring_runs).where(inArray(scoring_runs.label, labels));
  if (runRows.length === 0) {
    console.error(all ? "no runs in this database" : `no run matched ${labels.join(", ")}`);
    return 1;
  }
  const missing = labels.filter((l) => !runRows.some((r) => r.label === l));
  if (missing.length > 0) console.error(`no such run: ${missing.join(", ")}`);

  const comparisons: RunComparison[] = [];
  for (const run of runRows) {
    // The run's research rows, with the item each response belongs to.
    const research = await db
      .select({
        response_id: scores.response_id,
        item_id: responses.item_id,
        points: scores.points,
        max_points: scores.max_points,
        rationale: scores.rationale,
      })
      .from(scores)
      .innerJoin(responses, eq(responses.id, scores.response_id))
      .where(and(eq(scores.run_id, run.id), eq(scores.status, "research")));

    const finals =
      research.length === 0
        ? []
        : await db
            .select({
              response_id: scores.response_id,
              points: scores.points,
              max_points: scores.max_points,
              rationale: scores.rationale,
            })
            .from(scores)
            .where(
              and(
                inArray(scores.response_id, research.map((r) => r.response_id)),
                eq(scores.method, "human"),
                eq(scores.status, "final"),
              ),
            );
    const finalByResponse = new Map(finals.map((f) => [f.response_id, f]));

    const pairs: ComparisonPair[] = research.map((r) => {
      const human = finalByResponse.get(r.response_id);
      return {
        response_id: r.response_id,
        item_id: r.item_id,
        research: {
          points: r.points,
          max_points: r.max_points,
          rationale: r.rationale,
        },
        human: human
          ? {
              points: human.points,
              max_points: human.max_points,
              rationale: human.rationale,
            }
          : null,
      };
    });
    comparisons.push(
      compareRun({
        label: run.label,
        provider_id: run.provider_id,
        prompt_version: run.prompt_version,
        pairs,
      }),
    );
  }

  if (csv) {
    process.stdout.write(comparisonToCsv(comparisons));
    return 0;
  }

  const pct = (v: number | null): string =>
    v === null ? "—" : `${(v * 100).toFixed(1)}%`;
  const dec = (v: number | null): string => (v === null ? "—" : v.toFixed(3));
  for (const c of comparisons) {
    console.log(`── ${c.label}`);
    console.log(`   provider            ${c.provider_id}  (prompt ${c.prompt_version})`);
    console.log(`   research rows       ${c.n}  (${c.with_human_final} with a human final)`);
    console.log(`   exact agreement     ${pct(c.exact_agreement)}`);
    console.log(`   mean |Δ points|     ${dec(c.mean_abs_points_diff)}`);
    console.log(`   mean |Δ| / max      ${pct(c.mean_abs_diff_fraction)}`);
    console.log(
      `   criterion agreement ${pct(c.criterion.rate)}  ` +
        `(${c.criterion.agreed}/${c.criterion.compared} across ${c.criterion.pairs} responses)`,
    );
    console.log(
      `   would auto-finalize ${pct(c.hybrid_auto_finalize_rate)}  ` +
        `(confidence >= ${c.hybrid_threshold}, ${c.hybrid_confidence_rows} rows)`,
    );
  }
  return 0;
}

let code = 0;
try {
  code = await main();
} finally {
  await closeDb();
}
process.exit(code);
