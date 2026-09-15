// Slice 2 of docs/scoring-corpus-design.md: re-score already-answered essays
// as a named RUN, so a prompt or a model can be measured against the teacher's
// final. Operator script, not a route.
//
//   bun --env-file=.env.local scripts/score-corpus.ts \
//     --label "sonnet-4-6 prompt 2026-09-14 vs pilot finals" \
//     [--assessment <id>] [--item <id>] [--owner <sub>] \
//     [--with-human-final] [--since <date>] [--limit N] \
//     [--provider bedrock|mock] [--model <bedrock model id>] \
//     [--concurrency N] [--dry-run]
//
// --dry-run prints the count and a few response ids and exits 0 without
// creating a run. Otherwise: the run row, then one `research` score per
// response, progress every 10, the tally written to `scoring_runs.notes`.
// Exit 1 when nothing matched (a filter typo should not look like a success)
// and when the label is taken.
//
// Prints response / item / attempt ids only — never a student identifier.
import os from "node:os";
import { closeDb, getDb } from "../db/client";
import {
  CorpusArgsError,
  DuplicateRunLabelError,
  MAX_CONCURRENCY,
  corpusFilter,
  createRun,
  parseCorpusArgs,
  resolveCorpusProvider,
  scoreForCorpus,
  selectCorpusResponses,
  setRunNotes,
  summarizeOutcomes,
  type CorpusOptions,
  type CorpusOutcome,
  type CorpusRow,
} from "../lib/scoring/corpus";

const USAGE = [
  "usage: bun scripts/score-corpus.ts --label <label> [filters] [--dry-run]",
  "  filters: --assessment <id> --item <id> --owner <sub> --with-human-final",
  "           --since <date> --limit N",
  `  provider: --provider mock|bedrock --model <id> --concurrency 1-${MAX_CONCURRENCY}`,
].join("\n");

let opts: CorpusOptions;
try {
  opts = parseCorpusArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof CorpusArgsError) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  throw err;
}

const db = getDb();

async function main(): Promise<number> {
  const rows = await selectCorpusResponses(db, opts);
  console.log(`${rows.length} essay response(s) match the filter`);
  if (rows.length === 0) {
    console.error("nothing matched — check the filters (no run was created)");
    return 1;
  }
  for (const row of rows.slice(0, 5)) {
    console.log(
      `  response ${row.response.id}  item ${row.item.id}  method ${row.method}` +
        `  human final: ${row.humanFinal ? "yes" : "no"}`,
    );
  }
  if (rows.length > 5) console.log(`  … and ${rows.length - 5} more`);

  if (opts.dryRun) {
    console.log("--dry-run: no run created, nothing scored");
    return 0;
  }

  const provider = resolveCorpusProvider(opts);
  const run = await createRun(db, {
    label: opts.label,
    providerId: provider.id,
    promptVersion: provider.promptVersion,
    filter: corpusFilter(opts),
    createdBy: `cli:${os.userInfo().username}`,
  });
  console.log(
    `run ${run.id} "${run.label}" — provider ${provider.id}, prompt ${provider.promptVersion}, ` +
      `concurrency ${opts.concurrency}`,
  );

  // Worker pool over a shared cursor: `concurrency` workers pull the next
  // row until the list is exhausted. No library, and the progress counter is
  // the only shared mutable state.
  const outcomes: CorpusOutcome[] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const row: CorpusRow | undefined = rows[index];
      if (!row) return;
      const outcome = await scoreForCorpus({ db, run, row, provider });
      outcomes.push(outcome);
      done += 1;
      if (outcome.kind !== "scored") {
        console.log(
          `  response ${row.response.id}: ${outcome.kind}` +
            ("reason" in outcome ? ` (${outcome.reason})` : ""),
        );
      }
      if (done % 10 === 0) console.log(`  ${done}/${rows.length}`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, rows.length) }, worker),
  );

  const { tally, notes } = summarizeOutcomes(outcomes);
  await setRunNotes(db, run.id, notes);
  console.log(`run ${run.label}: ${notes}`);
  console.log(
    `compare it with: bun scripts/compare-runs.ts --run ${JSON.stringify(run.label)}`,
  );
  return tally.scored === 0 ? 1 : 0;
}

let code = 0;
try {
  code = await main();
} catch (err) {
  if (err instanceof DuplicateRunLabelError) {
    console.error(err.message);
    code = 1;
  } else {
    throw err;
  }
} finally {
  await closeDb();
}
process.exit(code);
