ALTER TABLE "students" ADD COLUMN "owner_email" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_owner_email_idx" ON "students" USING btree ("owner_email");--> statement-breakpoint
-- U-17 backfill: every (sub, email) pair the app has already recorded for a
-- teacher — assessments and sittings carry both. Newest pair per sub wins.
UPDATE "students" s
SET "owner_email" = pairs.email
FROM (
  SELECT DISTINCT ON (sub) sub, email FROM (
    SELECT owner_sub AS sub, lower(trim(owner_email)) AS email, updated_at AS at
      FROM "assessments" WHERE owner_email IS NOT NULL AND trim(owner_email) <> ''
    UNION ALL
    SELECT owner_sub, lower(trim(owner_email)), created_at
      FROM "test_sessions" WHERE owner_email IS NOT NULL AND trim(owner_email) <> ''
  ) all_pairs
  ORDER BY sub, at DESC
) pairs
WHERE s.owner_sub = pairs.sub AND s.owner_email IS NULL;
