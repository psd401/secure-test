// Slice 76: the sync entrypoint with the `mock` source (the test default)
// and a faked S3 client — no bucket, no credentials, no network.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { roster_students, roster_sync_runs } from "../db/schema";
import {
  MANIFEST_NAME,
  MockSnapshotSource,
  S3SnapshotSource,
  databaseUrlFromSecret,
  handleS3Event,
  waitForDatabase,
  snapshotIdFromManifestKey,
  summarize,
  type SyncLogger,
} from "../lib/roster/syncHandler";
import { loadExtract } from "./fixtures/roster/load";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`roster-sync-handler tests require the test DB; got: ${url}`);
  }
};

async function fixtureFiles(snapshotId = "fixture-2026-08-26") {
  const ex = await loadExtract();
  ex.manifest.snapshot_id = snapshotId;
  const files = new Map(ex.files);
  files.set(MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(ex.manifest)));
  return files;
}

function collectingLogger(): { log: SyncLogger; entries: unknown[] } {
  const entries: unknown[] = [];
  return { entries, log: (e) => void entries.push(e) };
}

describe("snapshotIdFromManifestKey", () => {
  test("accepts exactly <prefix><id>/manifest.json", () => {
    expect(snapshotIdFromManifestKey("roster/20260901T083000Z/manifest.json")).toBe(
      "20260901T083000Z",
    );
    expect(snapshotIdFromManifestKey("in/abc/manifest.json", "in/")).toBe("abc");
  });

  test("ignores the CSVs, nested paths, other prefixes and bad ids", () => {
    for (const key of [
      "roster/20260901/students.csv",
      "roster/20260901/extra/manifest.json",
      "other/20260901/manifest.json",
      "roster/manifest.json",
      "roster//manifest.json",
      "roster/has space/manifest.json",
      "roster/has+plus/manifest.json",
      "roster/" + "x".repeat(65) + "/manifest.json",
    ]) {
      expect(snapshotIdFromManifestKey(key)).toBeNull();
    }
  });

  test("decodes S3's URL-encoded keys", () => {
    expect(snapshotIdFromManifestKey("roster/2026-09-01T08%3A30%3A00Z/manifest.json")).toBe(
      "2026-09-01T08:30:00Z",
    );
  });
});

describe("databaseUrlFromSecret", () => {
  test("builds a URL from the RDS secret shape, escaping the password", () => {
    const url = databaseUrlFromSecret(
      JSON.stringify({
        username: "secure_test_admin",
        password: "p@ss/w:rd",
        host: "db.example.internal",
        port: 5432,
        dbname: "secure_test_design_tool",
      }),
    );
    expect(url).toBe(
      "postgres://secure_test_admin:p%40ss%2Fw%3Ard@db.example.internal:5432/secure_test_design_tool?sslmode=require",
    );
  });

  test("refuses a secret missing a field rather than building a half URL", () => {
    expect(() => databaseUrlFromSecret(JSON.stringify({ username: "u" }))).toThrow(
      /missing password/,
    );
  });
});

describe("waitForDatabase (9.1)", () => {
  const flaky = (failures: number) => {
    let calls = 0;
    return {
      probe: async () => {
        calls++;
        if (calls <= failures) throw new Error(`connect ETIMEDOUT #${calls}`);
        return 1;
      },
      calls: () => calls,
    };
  };

  test("answers on the first probe: no wait, no log", async () => {
    const { log, entries } = collectingLogger();
    const slept: number[] = [];
    const f = flaky(0);
    const attempt = await waitForDatabase(f.probe, {
      log,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(attempt).toBe(1);
    expect(f.calls()).toBe(1);
    expect(slept).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("a paused cluster: two misses logged as counts, then the third probe answers", async () => {
    const { log, entries } = collectingLogger();
    const slept: number[] = [];
    const f = flaky(2);
    const attempt = await waitForDatabase(f.probe, {
      attempts: 6,
      delayMs: 250,
      log,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(attempt).toBe(3);
    expect(f.calls()).toBe(3);
    expect(slept).toEqual([250, 250]);
    expect(entries).toEqual([
      { event: "roster_sync_db_wait", attempt: 1, of: 6, retry_in_ms: 250, error: "connect ETIMEDOUT #1" },
      { event: "roster_sync_db_wait", attempt: 2, of: 6, retry_in_ms: 250, error: "connect ETIMEDOUT #2" },
    ]);
  });

  test("never answers: the last error surfaces after exactly `attempts` probes", async () => {
    const { log, entries } = collectingLogger();
    const slept: number[] = [];
    const f = flaky(99);
    await expect(
      waitForDatabase(f.probe, { attempts: 3, delayMs: 1, log, sleep: async (ms) => { slept.push(ms); } }),
    ).rejects.toThrow("connect ETIMEDOUT #3");
    expect(f.calls()).toBe(3);
    expect(slept).toEqual([1, 1]);
    expect(entries.length).toBe(2);
  });
});

describe("summarize", () => {
  test("carries counts on success and the reason code on refusal — nothing else", () => {
    const ok = summarize("s1", {
      ok: true,
      run_id: "r",
      snapshot_id: "s1",
      counts: {
        students: { received: 1, upserted: 1, deactivated: 0 },
        sections: { received: 1, upserted: 1, deactivated: 0 },
        section_teachers: { received: 1, upserted: 1, deactivated: 0 },
        enrollments: { received: 1, upserted: 1, deactivated: 0 },
      },
    });
    expect(Object.keys(ok).sort()).toEqual(["counts", "event", "run_id", "snapshot_id", "status"]);
    const refused = summarize("s1", {
      ok: false,
      run_id: "r",
      snapshot_id: "s1",
      reason: "empty_table:students",
    });
    expect(Object.keys(refused).sort()).toEqual(["event", "reason", "run_id", "snapshot_id", "status"]);
  });
});

describe("S3SnapshotSource", () => {
  test("reads <prefix><id>/<path> and maps a missing key to null", async () => {
    const asked: string[] = [];
    const client = {
      async send(cmd: { input: { Bucket?: string; Key?: string } }) {
        asked.push(`${cmd.input.Bucket}:${cmd.input.Key}`);
        if (cmd.input.Key?.endsWith("missing.csv")) {
          const err = new Error("nope") as Error & { name: string; $metadata: { httpStatusCode: number } };
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { Body: { transformToByteArray: async () => new TextEncoder().encode('{"a":1}') } };
      },
    };
    const source = new S3SnapshotSource(client, "bkt", "roster/");
    expect(await source.readManifest("snap")).toEqual({ a: 1 });
    expect(await source.readFile("snap", "missing.csv")).toBeNull();
    expect(await source.readFile("snap", "../escape.csv")).toBeNull();
    expect(asked).toEqual(["bkt:roster/snap/manifest.json", "bkt:roster/snap/missing.csv"]);
  });

  test("any other S3 failure propagates — a transient error must retry, not refuse", async () => {
    const client = {
      async send() {
        throw new Error("throttled");
      },
    };
    const source = new S3SnapshotSource(client, "bkt");
    await expect(source.readFile("snap", "students.csv")).rejects.toThrow("throttled");
  });
});

describe("handleS3Event with the mock source (DB)", () => {
  beforeAll(() => expectTestDb());

  afterEach(async () => {
    await getDb().execute(
      sql`truncate table roster_enrollments, roster_section_teachers, roster_sections, roster_students, roster_sync_runs`,
    );
  });

  afterAll(async () => await closeDb());

  test("imports the snapshot named by a manifest key and logs counts only", async () => {
    const source = new MockSnapshotSource().add("night-1", await fixtureFiles("night-1"));
    const { log, entries } = collectingLogger();
    const outcome = await handleS3Event(
      getDb(),
      source,
      { Records: [{ s3: { object: { key: "roster/night-1/manifest.json" } } }] },
      "roster/",
      log,
    );
    expect(outcome).toEqual({ imported: ["night-1"], refused: [], ignored: 0 });
    const active = await getDb().select().from(roster_students);
    expect(active.length).toBe(7);

    expect(entries.length).toBe(1);
    const line = JSON.stringify(entries[0]);
    expect(line).toContain('"status":"succeeded"');
    expect(line).toContain('"received":7');
    for (const pii of ["Fixture", "edtools", "Ada", "teacher.one"]) {
      expect(line).not.toContain(pii);
    }
  });

  test("CSV puts are ignored; only the manifest triggers an import", async () => {
    const source = new MockSnapshotSource().add("night-1", await fixtureFiles("night-1"));
    const { log } = collectingLogger();
    const outcome = await handleS3Event(
      getDb(),
      source,
      {
        Records: [
          { s3: { object: { key: "roster/night-1/students.csv" } } },
          { s3: { object: { key: "roster/night-1/enrollments.csv" } } },
        ],
      },
      "roster/",
      log,
    );
    expect(outcome).toEqual({ imported: [], refused: [], ignored: 2 });
    expect((await getDb().select().from(roster_sync_runs)).length).toBe(0);
  });

  test("a manifest whose snapshot is absent from the source is refused and logged", async () => {
    const source = new MockSnapshotSource();
    const { log, entries } = collectingLogger();
    const outcome = await handleS3Event(
      getDb(),
      source,
      { Records: [{ s3: { object: { key: "roster/ghost/manifest.json" } } }] },
      "roster/",
      log,
    );
    expect(outcome).toEqual({ imported: [], refused: ["ghost"], ignored: 0 });
    expect(JSON.stringify(entries[0])).toContain('"reason":"manifest_invalid"');
    const [run] = await getDb().select().from(roster_sync_runs);
    expect(run?.status).toBe("refused");
  });

  test("a refused record does not stop a later good one in the same event", async () => {
    const broken = await fixtureFiles("night-1");
    broken.delete("sections.csv");
    const source = new MockSnapshotSource()
      .add("night-1", broken)
      .add("night-2", await fixtureFiles("night-2"));
    const { log } = collectingLogger();
    const outcome = await handleS3Event(
      getDb(),
      source,
      {
        Records: [
          { s3: { object: { key: "roster/night-1/manifest.json" } } },
          { s3: { object: { key: "roster/night-2/manifest.json" } } },
        ],
      },
      "roster/",
      log,
    );
    expect(outcome).toEqual({ imported: ["night-2"], refused: ["night-1"], ignored: 0 });
    const runs = await getDb().select().from(roster_sync_runs);
    expect(runs.map((r) => r.status).sort()).toEqual(["refused", "succeeded"]);
  });
});
