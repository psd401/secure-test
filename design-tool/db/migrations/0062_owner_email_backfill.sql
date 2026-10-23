-- Finding OE-1 (2026-10-22): the New assessment form never wrote
-- assessments.owner_email, so those rows stay NULL and roster suggestions /
-- teacher-scope grants do not resolve for them. The hotfix writes it at
-- create and fills it when the owner opens the assessment; this backfills
-- the rest from the OWNER's own records only (never a co-teacher's sitting,
-- whose owner_email is the co-teacher's):
--   1. the newest non-null owner_email on another assessment the same
--      owner_sub created;
--   2. else the newest sitting the owner started themselves
--      (test_sessions.owner_sub = assessments.owner_sub).
-- A row with neither keeps NULL.
UPDATE "assessments" a SET "owner_email" = o."owner_email"
  FROM (SELECT DISTINCT ON (owner_sub) owner_sub, owner_email
          FROM "assessments"
         WHERE owner_email IS NOT NULL
         ORDER BY owner_sub, updated_at DESC) o
 WHERE o.owner_sub = a."owner_sub" AND a."owner_email" IS NULL;--> statement-breakpoint
UPDATE "assessments" a SET "owner_email" = s."owner_email"
  FROM (SELECT DISTINCT ON (owner_sub) owner_sub, owner_email
          FROM "test_sessions"
         WHERE owner_email IS NOT NULL
         ORDER BY owner_sub, created_at DESC) s
 WHERE s.owner_sub = a."owner_sub" AND a."owner_email" IS NULL;
