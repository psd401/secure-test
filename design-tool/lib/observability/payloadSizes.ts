// Stored payload sizes, as aggregates only (2026-10-25). The per-route JSON
// body caps (the zod advisory's stopgap) need a ceiling per route that real
// use never reaches; the stored row a route writes is the nearest measure of
// the body that wrote it. This reads sizes and nothing else: no id, no
// content, no per-row line — the one-off task's stdout lands in CloudWatch.
import { sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export interface PayloadSizeRow {
  /** What was measured, and which route's body it stands in for. */
  category: string;
  rows: number;
  /** Bytes; null when the category has no rows. */
  p50: number | null;
  p99: number | null;
  max: number | null;
}

/**
 * One size expression per category, each `octet_length` of the JSON text the
 * route would have sent (a whole row for authoring writes, the one column for
 * the student routes). The expressions are fixed here — nothing from argv
 * reaches the SQL.
 */
export const PAYLOAD_CATEGORIES: ReadonlyArray<{ category: string; size: SQL; from: SQL }> = [
  {
    category: "items (item create/edit)",
    size: sql`octet_length(row_to_json(t)::text)`,
    from: sql`items t`,
  },
  {
    category: "rubrics (rubric create/edit)",
    size: sql`octet_length(row_to_json(t)::text)`,
    from: sql`rubrics t`,
  },
  {
    category: "assessments (assessment PATCH)",
    size: sql`octet_length(row_to_json(t)::text)`,
    from: sql`assessments t`,
  },
  {
    category: "item_sets (item-set writes)",
    size: sql`octet_length(row_to_json(t)::text)`,
    from: sql`item_sets t`,
  },
  {
    category: "responses.response (answer PUT)",
    size: sql`octet_length(t.response::text)`,
    from: sql`responses t`,
  },
  {
    category: "attempt_events.detail (events POST)",
    size: sql`octet_length(t.detail::text)`,
    from: sql`attempt_events t where t.detail is not null`,
  },
  {
    category: "peek_requests.image_base64 (peek upload)",
    size: sql`octet_length(t.image_base64)`,
    from: sql`peek_requests t where t.image_base64 is not null`,
  },
];

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));

export async function measurePayloadSizes(db: Db): Promise<PayloadSizeRow[]> {
  const out: PayloadSizeRow[] = [];
  for (const c of PAYLOAD_CATEGORIES) {
    const [r] = (await db.execute(sql`
      select count(*)::int as rows,
             percentile_cont(0.5) within group (order by s) as p50,
             percentile_cont(0.99) within group (order by s) as p99,
             max(s) as max
      from (select ${c.size} as s from ${c.from}) sizes
    `)) as unknown as Array<{ rows: number; p50: unknown; p99: unknown; max: unknown }>;
    out.push({
      category: c.category,
      rows: Number(r?.rows ?? 0),
      p50: num(r?.p50),
      p99: num(r?.p99),
      max: num(r?.max),
    });
  }
  return out;
}

const kib = (b: number | null) => (b === null ? "-" : `${(b / 1024).toFixed(1)} KiB`);

/** The table the script prints: one line per category, sizes in KiB. */
export function formatPayloadSizes(rows: PayloadSizeRow[]): string {
  const lines = [
    "── stored payload sizes (bytes of JSON text; aggregates only)",
    `${"category".padEnd(44)} ${"rows".padStart(8)} ${"p50".padStart(12)} ${"p99".padStart(12)} ${"max".padStart(12)}`,
  ];
  for (const r of rows) {
    lines.push(
      `${r.category.padEnd(44)} ${String(r.rows).padStart(8)} ${kib(r.p50).padStart(12)} ${kib(r.p99).padStart(12)} ${kib(r.max).padStart(12)}`,
    );
  }
  return lines.join("\n");
}
