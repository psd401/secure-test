import { and, desc, eq, notInArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { item_snapshots, type ItemRow, type ItemSnapshotContent } from "@/db/schema";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * R-5 (docs/editor-redesign-design.md, Q2: a new item-snapshot table): item
 * version history for the autosaving editor.
 *
 * Capture runs inside the item PATCH, before nothing else can see the write:
 * the content the PATCH replaces is copied to `item_snapshots`. The new
 * editor saves about once a second while a teacher types, so copies are
 * coalesced — at most one every `SNAPSHOT_INTERVAL_MS` per item — and each
 * item keeps its newest `SNAPSHOT_KEEP`. A restore (`force`) always copies
 * the version it replaces, so restoring the wrong version loses nothing.
 */
export const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
export const SNAPSHOT_KEEP = 50;

/** The fields a version holds: everything the PATCH body can change. */
export function itemContent(
  row: Pick<ItemRow, "type" | "stem" | "choices" | "correct_choice_ids" | "correct_answer" | "config" | "standards">,
): ItemSnapshotContent {
  return {
    type: row.type,
    stem: row.stem,
    choices: row.choices ?? [],
    correct_choice_ids: row.correct_choice_ids ?? [],
    correct_answer: row.correct_answer ?? null,
    config: row.config ?? {},
    standards: Array.isArray(row.standards) ? row.standards : [],
  };
}

/** JSON with object keys sorted, so two copies of the same content compare
 * equal whichever order jsonb or the editor put their keys in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sameContent(a: ItemSnapshotContent, b: ItemSnapshotContent): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Pure: should this write copy the content it replaces?
 * - never for a write that changes nothing, or when the newest copy already
 *   holds that content;
 * - always for a restore, and for an item with no copy yet;
 * - otherwise only once the newest copy is `SNAPSHOT_INTERVAL_MS` old.
 */
export function shouldCapture(args: {
  before: ItemSnapshotContent;
  after: ItemSnapshotContent;
  latest: { content: ItemSnapshotContent; captured_at: Date } | null;
  now: Date;
  force?: boolean;
}): boolean {
  const { before, after, latest, now, force } = args;
  if (sameContent(before, after)) return false;
  if (latest && sameContent(latest.content, before)) return false;
  if (force || !latest) return true;
  return now.getTime() - latest.captured_at.getTime() >= SNAPSHOT_INTERVAL_MS;
}

/** Copy `before` into the item's history when `shouldCapture` says so, then
 * prune to the newest `SNAPSHOT_KEEP`. Returns whether a copy was written. */
export async function captureItemSnapshot(
  tx: Tx,
  before: ItemRow,
  after: ItemRow,
  opts: { force?: boolean; now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const [latest] = await tx
    .select({ content: item_snapshots.content, captured_at: item_snapshots.captured_at })
    .from(item_snapshots)
    .where(eq(item_snapshots.item_id, before.id))
    .orderBy(desc(item_snapshots.captured_at))
    .limit(1);
  const take = shouldCapture({
    before: itemContent(before),
    after: itemContent(after),
    latest: latest ?? null,
    now,
    force: opts.force,
  });
  if (!take) return false;
  await tx.insert(item_snapshots).values({
    item_id: before.id,
    content: itemContent(before),
    saved_at: before.updated_at,
    captured_at: now,
  });
  const keep = tx
    .select({ id: item_snapshots.id })
    .from(item_snapshots)
    .where(eq(item_snapshots.item_id, before.id))
    .orderBy(desc(item_snapshots.captured_at))
    .limit(SNAPSHOT_KEEP);
  await tx
    .delete(item_snapshots)
    .where(and(eq(item_snapshots.item_id, before.id), notInArray(item_snapshots.id, keep)));
  return true;
}

/** An item's earlier versions, newest first. */
export async function listItemSnapshots(db: Db, itemId: string) {
  return db
    .select({
      id: item_snapshots.id,
      content: item_snapshots.content,
      saved_at: item_snapshots.saved_at,
      captured_at: item_snapshots.captured_at,
    })
    .from(item_snapshots)
    .where(eq(item_snapshots.item_id, itemId))
    .orderBy(desc(item_snapshots.captured_at))
    .limit(SNAPSHOT_KEEP);
}
