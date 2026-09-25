// Slice 4 of docs/scoring-corpus-design.md: the container entrypoint's mode
// dispatch and argv hand-off. The real targets (db/migrate.mjs,
// scripts/score-corpus.mjs, scripts/compare-runs.mjs) exist only inside the
// Fargate image, and every path the entrypoint imports is resolved relative
// to its OWN location — so the test copies the entrypoint into a temp
// directory beside stub targets and runs it with plain node, exactly as the
// container's command does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The stub each mode resolves to: prints what the script would see as its
// own arguments, which is the whole point of the argv splice.
const STUB = (name: string) =>
  `console.log(${JSON.stringify(name)} + " " + JSON.stringify(process.argv.slice(2)));\n` +
  `console.log("url=" + process.env.DATABASE_URL);\n`;

let dir: string;
let entry: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "entrypoint-"));
  // Mirror the image layout: the entrypoint in scripts/, its siblings beside
  // it, and ../db/migrate.mjs + ../server.js one level up.
  await mkdir(path.join(dir, "scripts"));
  await mkdir(path.join(dir, "db"));
  entry = path.join(dir, "scripts", "docker-entrypoint.mjs");
  await copyFile(
    path.join(import.meta.dir, "..", "scripts", "docker-entrypoint.mjs"),
    entry,
  );
  await writeFile(path.join(dir, "scripts", "score-corpus.mjs"), STUB("corpus"));
  await writeFile(path.join(dir, "scripts", "compare-runs.mjs"), STUB("compare"));
  await writeFile(path.join(dir, "db", "migrate.mjs"), STUB("migrate"));
  await writeFile(path.join(dir, "server.js"), STUB("server"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(
  args: string[],
  env: Record<string, string> = { DATABASE_URL: "postgres://stub/stub" },
): Promise<{ code: number; out: string; url: string; err: string }> {
  const proc = Bun.spawn(["node", entry, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = out.trim().split("\n");
  return {
    code,
    out: lines[0] ?? "",
    url: (lines[1] ?? "").replace(/^url=/, ""),
    err: err.trim(),
  };
}

async function runAll(
  env: Record<string, string>,
): Promise<{ code: number; lines: string[] }> {
  const proc = Bun.spawn(["node", entry], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, lines: out.trim().split("\n") };
}

describe("docker-entrypoint mode dispatch", () => {
  // DS-1 (2026-09-25): a server boot applies migrations FIRST.
  test("no argument migrates, then boots the server", async () => {
    const { code, lines } = await runAll({ DATABASE_URL: "postgres://stub/stub" });
    const migrate = lines.indexOf("migrate []");
    const server = lines.indexOf("server []");
    expect(migrate).toBeGreaterThan(-1);
    expect(server).toBeGreaterThan(migrate);
    expect(code).toBe(0);
  });

  test("SKIP_MIGRATE_ON_START=1 boots the server without migrating", async () => {
    const { code, lines } = await runAll({
      DATABASE_URL: "postgres://stub/stub",
      SKIP_MIGRATE_ON_START: "1",
    });
    expect(lines).not.toContain("migrate []");
    expect(lines).toContain("server []");
    expect(code).toBe(0);
  });

  test("a failing boot migration exits non-zero and never starts the server", async () => {
    const failDir = await mkdtemp(path.join(os.tmpdir(), "entrypoint-fail-"));
    try {
      await mkdir(path.join(failDir, "scripts"));
      await mkdir(path.join(failDir, "db"));
      const failEntry = path.join(failDir, "scripts", "docker-entrypoint.mjs");
      await copyFile(entry, failEntry);
      await writeFile(path.join(failDir, "db", "migrate.mjs"), 'throw new Error("migration failed");\n');
      await writeFile(path.join(failDir, "server.js"), STUB("server"));
      const proc = Bun.spawn(["node", failEntry], {
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgres://stub/stub" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).not.toBe(0);
      expect(out).not.toContain("server []");
    } finally {
      await rm(failDir, { recursive: true, force: true });
    }
  });

  test("each mode runs its own bundled script", async () => {
    for (const mode of ["migrate", "corpus", "compare"]) {
      const { code, out } = await run([mode]);
      expect(out).toBe(`${mode} []`);
      expect(code).toBe(0);
    }
  });

  test("everything after the mode is the script's own argv", async () => {
    // A label with spaces is the arg that a mis-built override or a missing
    // splice would mangle (infra/scripts/oneoff-aurora.sh builds the JSON).
    const { code, out } = await run([
      "corpus",
      "--label",
      "sonnet-4-6 prompt 2026-09-14 vs pilot finals",
      "--with-human-final",
      "--dry-run",
    ]);
    expect(out).toBe(
      'corpus ["--label","sonnet-4-6 prompt 2026-09-14 vs pilot finals","--with-human-final","--dry-run"]',
    );
    expect(code).toBe(0);
  });

  test("a mode's arguments are never read as modes", async () => {
    const { code, out } = await run(["compare", "--all", "--csv"]);
    expect(out).toBe('compare ["--all","--csv"]');
    expect(code).toBe(0);
  });

  test("an unknown mode exits 64 and names the modes", async () => {
    const { code, err } = await run(["bogus"]);
    expect(code).toBe(64);
    expect(err).toContain('unknown mode "bogus"');
    expect(err).toContain("migrate, corpus, compare");
  });

  test("the DB_* shim assembles DATABASE_URL for a mode too", async () => {
    const { code, out, url } = await run(["corpus", "--dry-run"], {
      DB_HOST: "aurora.example",
      DB_PORT: "5432",
      DB_NAME: "app",
      DB_USER: "user name",
      DB_PASSWORD: "p@ss/word",
    });
    expect(code).toBe(0);
    expect(out).toBe('corpus ["--dry-run"]');
    expect(url).toBe(
      "postgres://user%20name:p%40ss%2Fword@aurora.example:5432/app?sslmode=require",
    );
  });

  test("a mode with neither DATABASE_URL nor DB_* exits 64", async () => {
    const { code, err } = await run(["corpus"], {});
    expect(code).toBe(64);
    expect(err).toContain("no DATABASE_URL and missing");
  });
});
