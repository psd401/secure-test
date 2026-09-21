// createSessionWithCode's retry path, mocked rather than hitting the real DB
// (cheap per docs/access-model-design.md's review note) — proves the
// isUniqueViolation cause-walk extraction actually reaches this call site.
// Before the extraction, testSessions.ts's own isUniqueViolation read
// `err.code` off the top level only, so a DrizzleQueryError-shaped
// collision (SQLSTATE on `.cause`) would have rethrown as a 500 instead of
// retrying with a new code.
import { describe, expect, test } from "bun:test";
import { createSessionWithCode, CodeExhaustionError } from "../lib/api/testSessions";

class DrizzleQueryError extends Error {
  cause: unknown;
  constructor(cause: unknown) {
    super("query failed");
    this.cause = cause;
  }
}

function fakeDb(behaviors: Array<"collide" | "insert">) {
  let call = 0;
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const behavior = behaviors[call++];
          if (behavior === "collide") {
            throw new DrizzleQueryError({ code: "23505" });
          }
          return [{ id: "session-1", ...row }];
        },
      }),
    }),
  } as unknown as Parameters<typeof createSessionWithCode>[0];
}

const baseValues = {
  assessment_id: "assessment-1",
  owner_sub: "owner-sub",
  expires_at: new Date(Date.now() + 60_000),
};

describe("createSessionWithCode retry", () => {
  test("retries past a DrizzleQueryError-wrapped 23505 and succeeds", async () => {
    const db = fakeDb(["collide", "collide", "insert"]);
    const row = await createSessionWithCode(db, baseValues);
    expect(row.id).toBe("session-1");
  });

  test("gives up after exhausting the attempt budget", async () => {
    const db = fakeDb(["collide", "collide", "collide"]);
    await expect(createSessionWithCode(db, baseValues, 3)).rejects.toBeInstanceOf(
      CodeExhaustionError,
    );
  });

  test("a non-unique-violation error is not swallowed", async () => {
    const db = {
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new DrizzleQueryError({ code: "23503" });
          },
        }),
      }),
    } as unknown as Parameters<typeof createSessionWithCode>[0];
    await expect(createSessionWithCode(db, baseValues)).rejects.toBeInstanceOf(DrizzleQueryError);
  });
});
