// How big are the payloads the API routes actually store? (2026-10-25)
//
//   DATABASE_URL=postgres://… bun scripts/payload-sizes.ts
//   infra/scripts/oneoff-aurora.sh payload-sizes
//
// Read-only. Prints, per category, the row count and the p50 / p99 / max
// size of the stored JSON text — the evidence for the per-route JSON body
// caps. No id, no content, no per-row line (stdout lands in CloudWatch).
import { closeDb, getDb } from "../db/client";
import { formatPayloadSizes, measurePayloadSizes } from "../lib/observability/payloadSizes";

const rows = await measurePayloadSizes(getDb());
await closeDb();
console.log(formatPayloadSizes(rows));
