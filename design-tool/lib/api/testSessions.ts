import { randomInt } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { test_sessions } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 60: session codes.
 *
 * Read aloud in a classroom and typed by children, so the alphabet excludes
 * every character pair that is hard to tell apart on a projector or in
 * handwriting: 0/O, 1/I/L, and the lowercase forms entirely. What is left is 31
 * symbols, giving 31^6 ≈ 887 million codes.
 *
 * Generated with crypto randomness rather than Math.random. A code is the only
 * thing standing between a guess and an attempt to join somebody else's sitting
 * — redemption also demands a student session and roster membership, so a
 * guessed code alone achieves nothing, but a predictable sequence would let
 * someone enumerate which sittings are live.
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

export function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Codes are typed by hand, so normalise before comparing: trim, uppercase, and
 * drop the separators people insert unprompted. Without this, "abc-123" typed
 * for code "ABC123" is a mystifying failure.
 */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

export function isWellFormedCode(input: string): boolean {
  const normalized = normalizeCode(input);
  if (normalized.length !== CODE_LENGTH) return false;
  return [...normalized].every((ch) => CODE_ALPHABET.includes(ch));
}

/**
 * Closes this owner's sittings that are past their expiry.
 *
 * The partial unique index that keeps codes distinct is predicated on
 * `status = 'open'`, and a time comparison cannot live in an index predicate
 * (now() is not immutable). So an expired-but-unclosed sitting keeps holding
 * its code. Sweeping on the create path keeps that window short without a cron
 * job — the cost is one indexed UPDATE per session a teacher creates.
 */
export async function sweepExpired(db: Db, ownerSub: string): Promise<number> {
  const closed = await db
    .update(test_sessions)
    .set({ status: "closed", updated_at: new Date() })
    .where(
      and(
        eq(test_sessions.owner_sub, ownerSub),
        eq(test_sessions.status, "open"),
        lt(test_sessions.expires_at, new Date()),
      ),
    )
    .returning({ id: test_sessions.id });
  return closed.length;
}

export class CodeExhaustionError extends Error {
  constructor() {
    super("could not allocate an unused session code");
    this.name = "CodeExhaustionError";
  }
}

/**
 * Inserts a sitting, retrying on a code collision.
 *
 * The retry is driven by the unique index rather than by a pre-flight SELECT:
 * checking first and inserting second is a race, and the index is the only
 * thing that actually decides. Collisions are rare enough at any plausible
 * district scale that a handful of attempts is generous.
 */
export async function createSessionWithCode(
  db: Db,
  values: {
    assessment_id: string;
    owner_sub: string;
    owner_email?: string | null;
    section_ps_id?: string | null;
    student_ps_ids?: string[] | null;
    expires_at: Date;
  },
  attempts = 8,
) {
  for (let i = 0; i < attempts; i++) {
    try {
      const [row] = await db
        .insert(test_sessions)
        .values({ ...values, code: generateCode(), status: "open" })
        .returning();
      if (row) return row;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new CodeExhaustionError();
}

function isUniqueViolation(err: unknown): boolean {
  // postgres.js surfaces the SQLSTATE on the error object.
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

// --- request bodies ---

export const DEFAULT_DURATION_MINUTES = 120;
export const MAX_DURATION_MINUTES = 60 * 12;
