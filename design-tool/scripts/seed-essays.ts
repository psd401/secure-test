// Seed submitted pilot essays for named students, without the macOS client.
//
//   bun --env-file=.env.local scripts/seed-essays.ts \
//     --assessment <uuid> --session-code <6 chars> \
//     --student <student-number>=high --student <student-number>=mid \
//     [--student …] [--dry-run]
//
// On the deployed origin it runs inside the image, from outside the VPC:
//
//   design-tool/infra/scripts/oneoff-aurora.sh seed-essays \
//     --assessment <uuid> --session-code ABC123 --student <student-number>=high
//
// Qualities: high | mid | low | brief | offtopic (lib/dev/sampleEssays.ts).
//
// Pre-steps, in this order: Publish the assessment; Start session with Picked
// students = the students below; copy the Session code. See infra/README.md
// "Seeding pilot essays".
//
// There is ONE attempt per student per assessment, so a re-run refuses until
// the previous attempt is deleted on the results page. --dry-run validates
// everything and writes nothing.
//
// Prints student NUMBERS (the operator typed them) and row ids only — never a
// name, never an address.
import { closeDb, getDb } from "../db/client";
import { ESSAY_QUALITIES, isEssayQuality, type EssayQuality } from "../lib/dev/sampleEssays";
import {
  SeedEssaysError,
  seedEssays,
  type SeedEssaysStudent,
} from "../lib/dev/seedEssays";

const USAGE = [
  "usage: bun scripts/seed-essays.ts --assessment <uuid> --session-code <code> \\",
  "         --student <student-number>=<quality> [--student …] [--dry-run]",
  `  quality: ${ESSAY_QUALITIES.join(" | ")}`,
].join("\n");

class ArgsError extends Error {}

type Args = {
  assessmentId: string;
  sessionCode: string;
  students: SeedEssaysStudent[];
  dryRun: boolean;
};

export function parseSeedEssaysArgs(argv: readonly string[]): Args {
  const students: SeedEssaysStudent[] = [];
  let assessmentId: string | undefined;
  let sessionCode: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      throw new ArgsError(`unexpected argument "${arg}" — every input is a --flag`);
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name === "--dry-run") {
      if (eq !== -1) throw new ArgsError("--dry-run takes no value");
      dryRun = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new ArgsError(`${name} needs a value`);
    }
    switch (name) {
      case "--assessment":
        if (assessmentId !== undefined) throw new ArgsError("--assessment given twice");
        assessmentId = value.trim();
        break;
      case "--session-code":
        if (sessionCode !== undefined) throw new ArgsError("--session-code given twice");
        sessionCode = value.trim();
        break;
      case "--student":
        students.push(parseStudent(value));
        break;
      default:
        throw new ArgsError(
          `unknown flag "${name}". Known flags: --assessment, --session-code, --student, --dry-run`,
        );
    }
  }

  if (!assessmentId) throw new ArgsError("--assessment is required");
  if (!sessionCode) throw new ArgsError("--session-code is required");
  if (students.length === 0) {
    throw new ArgsError(
      "--student is required at least once — this script never scans the roster, " +
        "every student is named on the command line",
    );
  }
  return { assessmentId, sessionCode, students, dryRun };
}

function parseStudent(value: string): SeedEssaysStudent {
  const at = value.indexOf("=");
  if (at === -1) {
    throw new ArgsError(
      `--student wants <student-number>=<quality>; got "${value}"`,
    );
  }
  const studentNumber = value.slice(0, at).trim();
  const quality = value.slice(at + 1).trim();
  if (!/^\d{5,8}$/.test(studentNumber)) {
    throw new ArgsError(
      `"${studentNumber}" is not a student number (5-8 digits)`,
    );
  }
  if (!isEssayQuality(quality)) {
    throw new ArgsError(
      `unknown quality "${quality}" — one of ${ESSAY_QUALITIES.join(", ")}`,
    );
  }
  return { studentNumber, quality: quality as EssayQuality };
}

let args: Args;
try {
  args = parseSeedEssaysArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof ArgsError) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  throw err;
}

const db = getDb();

async function main(): Promise<number> {
  const result = await seedEssays(db, {
    assessmentId: args.assessmentId,
    sessionCode: args.sessionCode,
    students: args.students,
    dryRun: args.dryRun,
  });

  console.log(
    `assessment "${result.assessmentName}" (${args.assessmentId}), sitting ${result.sittingId}`,
  );
  console.log(
    `${result.essayItemIds.length} essay item(s): ${result.essayItemIds.join(", ")}`,
  );
  for (const skipped of result.skippedItems) {
    console.log(`  skipping item ${skipped.id} at position ${skipped.position} — ${skipped.type}, not an essay`);
  }

  if (result.dryRun) {
    for (const row of result.planned) {
      console.log(
        `  would seed student ${row.studentNumber}: ${row.quality} (${row.words} words)` +
          `${row.overlayWillBeCreated ? ", creating this teacher's student row" : ""}`,
      );
    }
    console.log(`--dry-run: ${result.planned.length} attempt(s) would be written, nothing was`);
    return 0;
  }

  for (const row of result.written) {
    console.log(
      `  student ${row.studentNumber}: ${row.quality} (${row.words} words) → attempt ${row.attemptId}, ` +
        `${row.responseCount} response(s), ${row.autoScored} auto-scored`,
    );
  }
  console.log(
    `seeded ${result.written.length} submitted attempt(s) on "${result.assessmentName}" — ` +
      "score them from the Scoring queue",
  );
  return 0;
}

let code = 0;
try {
  code = await main();
} catch (err) {
  if (err instanceof SeedEssaysError) {
    console.error(`seed-essays refused: ${err.message}`);
    code = 1;
  } else {
    throw err;
  }
} finally {
  await closeDb();
}
process.exit(code);
