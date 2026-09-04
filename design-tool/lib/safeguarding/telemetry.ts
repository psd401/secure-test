import { getDb } from "@/db/client";
import { guardrail_events } from "@/db/schema";
import type {
  GuardrailAction,
  GuardrailFinding,
  GuardrailStage,
  GuardrailSurface,
} from "./types";

/** A single guardrail check to persist to guardrail_events. */
export interface GuardrailEventInput {
  owner_sub: string;
  surface: GuardrailSurface;
  stage: GuardrailStage;
  action: GuardrailAction;
  provider_id: string;
  findings: GuardrailFinding[];
  text_snippet: string;
}

/**
 * Pluggable recorder. The wrapper depends on this type so tests can
 * inject a fake that captures events in an array instead of touching
 * Postgres; the default below writes a row.
 */
export type RecordGuardrailEvent = (e: GuardrailEventInput) => Promise<void>;

/** Default recorder: insert one row into guardrail_events. */
export const recordGuardrailEvent: RecordGuardrailEvent = async (e) => {
  const db = getDb();
  await db.insert(guardrail_events).values({
    owner_sub: e.owner_sub,
    surface: e.surface,
    stage: e.stage,
    action: e.action,
    provider_id: e.provider_id,
    findings: e.findings,
    text_snippet: e.text_snippet,
  });
};
