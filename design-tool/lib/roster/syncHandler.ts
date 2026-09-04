// Slice 76 (ADR 0017): the sync entrypoint — what runs when a snapshot lands.
//
// The Lambda in design-tool/infra is a thin wrapper around `handleS3Event`;
// everything with logic lives here so it runs under `bun test` with the
// `mock` source. The seam is `SnapshotSource`: S3 in production, an in-memory
// map in tests, a directory on disk for the manual run
// (scripts/roster-import-local.ts).
//
// The trigger is the MANIFEST, not the CSVs. The contract (docs/
// roster-extract.md) has the producer write manifest.json last, so its
// arrival means the other four files are complete; an event for any other
// key is ignored on purpose.
//
// Logging rule: counts and codes only. This runs in a Lambda whose logs go
// to CloudWatch, and nothing that reaches CloudWatch may name a student.

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { getDb } from "@/db/client";
import { importSnapshot, type ImportCounts, type ImportResult } from "./importSnapshot";

type Db = ReturnType<typeof getDb>;

export const MANIFEST_NAME = "manifest.json";
export const DEFAULT_PREFIX = "roster/";

export interface SnapshotSource {
  /** The parsed manifest, or null when there is none at that snapshot. */
  readManifest(snapshotId: string): Promise<unknown | null>;
  readFile(snapshotId: string, path: string): Promise<Uint8Array | null>;
}

// --- sources ---

/** The test/CI default: snapshots as in-memory maps of path → bytes. */
export class MockSnapshotSource implements SnapshotSource {
  private snapshots = new Map<string, Map<string, Uint8Array>>();

  add(snapshotId: string, files: Map<string, Uint8Array>): this {
    this.snapshots.set(snapshotId, files);
    return this;
  }

  async readManifest(snapshotId: string): Promise<unknown | null> {
    const bytes = this.snapshots.get(snapshotId)?.get(MANIFEST_NAME);
    return bytes ? parseJsonOrNull(bytes) : null;
  }

  async readFile(snapshotId: string, path: string): Promise<Uint8Array | null> {
    return this.snapshots.get(snapshotId)?.get(path) ?? null;
  }
}

/** The subset of S3Client this needs, so a test can hand in a fake. */
export interface S3Like {
  send(command: GetObjectCommand): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
  }>;
}

export class S3SnapshotSource implements SnapshotSource {
  constructor(
    private readonly client: S3Like | S3Client,
    private readonly bucket: string,
    private readonly prefix: string = DEFAULT_PREFIX,
  ) {}

  async readManifest(snapshotId: string): Promise<unknown | null> {
    const bytes = await this.readFile(snapshotId, MANIFEST_NAME);
    return bytes ? parseJsonOrNull(bytes) : null;
  }

  async readFile(snapshotId: string, path: string): Promise<Uint8Array | null> {
    // `path` was validated as a bare file name by the manifest schema before
    // it gets here for the CSVs; the manifest name is a constant. Belt and
    // braces: refuse anything that could leave the snapshot prefix anyway.
    if (!/^[A-Za-z0-9._-]+$/.test(path)) return null;
    const Key = `${this.prefix}${snapshotId}/${path}`;
    try {
      const out = await (this.client as S3Like).send(
        new GetObjectCommand({ Bucket: this.bucket, Key }),
      );
      if (!out.Body) return null;
      return await out.Body.transformToByteArray();
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }
}

function isNoSuchKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

function parseJsonOrNull(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

// --- key parsing ---

/**
 * `roster/<snapshot_id>/manifest.json` → `<snapshot_id>`; anything else →
 * null. S3 event keys are URL-encoded (a space arrives as `+`), so decode
 * first. The snapshot id must satisfy the same character class the manifest
 * schema enforces — a key that does not is not one of ours.
 */
export function snapshotIdFromManifestKey(
  rawKey: string,
  prefix: string = DEFAULT_PREFIX,
): string | null {
  const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length).split("/");
  if (rest.length !== 2 || rest[1] !== MANIFEST_NAME) return null;
  const id = rest[0]!;
  return /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : null;
}

// --- the run ---

export interface SyncLogEntry {
  event: "roster_sync";
  snapshot_id: string;
  status: "succeeded" | "refused";
  reason?: string;
  counts?: ImportCounts;
  run_id: string;
}

export type SyncLogger = (entry: SyncLogEntry | { event: string; [k: string]: unknown }) => void;

export const consoleJsonLogger: SyncLogger = (entry) => {
  console.log(JSON.stringify(entry));
};

export interface WaitForDatabaseOptions {
  /** Probes before giving up; the last failure is rethrown. */
  attempts?: number;
  /** Pause between probes. */
  delayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: SyncLogger;
}

/**
 * Follow-up 9.1 (2026-08-28): the dev cluster is Aurora Serverless v2 at
 * `minCapacity 0`, so between pushes it is PAUSED and the importer's first
 * connection is what resumes it. The resume outran the client's connect
 * window on the first real run (`connect ETIMEDOUT` at ~17 s); S3's async
 * retry 80 s later succeeded. Rather than lean on S3's two retries — and
 * log one ERROR per morning — probe the database until it answers, logging
 * each miss as a count, then run the import. Six probes ten seconds apart
 * plus the connect timeouts stay well inside the function's ten minutes.
 * Any other failure surfaces after the last probe exactly as before.
 */
export async function waitForDatabase(
  probe: () => Promise<unknown>,
  opts: WaitForDatabaseOptions = {},
): Promise<number> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? consoleJsonLogger;
  for (let attempt = 1; ; attempt++) {
    try {
      await probe();
      return attempt;
    } catch (err) {
      if (attempt >= attempts) throw err;
      log({
        event: "roster_sync_db_wait",
        attempt,
        of: attempts,
        retry_in_ms: delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }
}

/** Imports one snapshot from a source and logs the outcome — counts and
 * codes only. */
export async function runSync(
  db: Db,
  source: SnapshotSource,
  snapshotId: string,
  log: SyncLogger = consoleJsonLogger,
): Promise<ImportResult> {
  const manifest = await source.readManifest(snapshotId);
  const result = await importSnapshot(db, {
    manifest,
    readFile: (path) => source.readFile(snapshotId, path),
  });
  log(summarize(snapshotId, result));
  return result;
}

export function summarize(snapshotId: string, result: ImportResult): SyncLogEntry {
  if (result.ok) {
    return {
      event: "roster_sync",
      snapshot_id: snapshotId,
      status: "succeeded",
      counts: result.counts,
      run_id: result.run_id,
    };
  }
  return {
    event: "roster_sync",
    snapshot_id: snapshotId,
    status: "refused",
    reason: result.reason,
    run_id: result.run_id,
  };
}

/** The shape of an S3 put notification this cares about. Declared here
 * rather than imported from @types/aws-lambda so the design-tool package
 * has no dependency on it. */
export interface S3EventLike {
  Records?: Array<{ s3?: { object?: { key?: string } } }>;
}

export interface S3EventOutcome {
  imported: string[];
  refused: string[];
  ignored: number;
}

/**
 * Handles one S3 event: every record whose key is a manifest is imported in
 * order; every other record is counted and skipped. A refused snapshot does
 * not stop the next record — one bad night's extract must not shadow a good
 * re-push behind it in the same batch.
 */
export async function handleS3Event(
  db: Db,
  source: SnapshotSource,
  event: S3EventLike,
  prefix: string = DEFAULT_PREFIX,
  log: SyncLogger = consoleJsonLogger,
): Promise<S3EventOutcome> {
  const outcome: S3EventOutcome = { imported: [], refused: [], ignored: 0 };
  for (const record of event.Records ?? []) {
    const key = record.s3?.object?.key;
    const snapshotId = key ? snapshotIdFromManifestKey(key, prefix) : null;
    if (!snapshotId) {
      outcome.ignored++;
      continue;
    }
    const result = await runSync(db, source, snapshotId, log);
    (result.ok ? outcome.imported : outcome.refused).push(snapshotId);
  }
  if (outcome.ignored > 0) {
    log({ event: "roster_sync_ignored", records: outcome.ignored });
  }
  return outcome;
}

// --- Lambda environment ---

/** Builds a postgres URL from the JSON Secrets Manager stores for an RDS
 * cluster ({username, password, host, port, dbname}). Exported for its test;
 * the Lambda entry calls it once per cold start. */
export function databaseUrlFromSecret(secretJson: string): string {
  const s = JSON.parse(secretJson) as Record<string, unknown>;
  for (const k of ["username", "password", "host", "port", "dbname"]) {
    if (s[k] === undefined || s[k] === null || s[k] === "") {
      throw new Error(`database secret is missing ${k}`);
    }
  }
  const user = encodeURIComponent(String(s.username));
  const pass = encodeURIComponent(String(s.password));
  return `postgres://${user}:${pass}@${s.host}:${s.port}/${s.dbname}?sslmode=require`;
}
