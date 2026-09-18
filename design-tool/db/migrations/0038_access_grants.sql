CREATE TABLE IF NOT EXISTS "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grantee_email" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"level" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"granted_by_sub" text NOT NULL,
	"granted_by_email" text NOT NULL,
	"note" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grants_scope_kind_check" CHECK (scope_kind IN ('assessment', 'teacher', 'school')),
	CONSTRAINT "access_grants_level_check" CHECK (level IN ('view', 'run', 'edit', 'own'))
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "owner_email" text;--> statement-breakpoint
-- Access slice 2: backfill the owner's email from the only place the app
-- already recorded it -- the sittings that teacher has started on this
-- assessment. The newest sitting wins (a teacher's address can change).
-- An assessment nobody has ever sat keeps NULL, so a teacher-scope grant
-- does not resolve for it until its owner next creates/imports/duplicates.
UPDATE "assessments" a SET "owner_email" = s."owner_email"
  FROM (SELECT DISTINCT ON (assessment_id) assessment_id, owner_email
          FROM "test_sessions"
         WHERE owner_email IS NOT NULL
         ORDER BY assessment_id, created_at DESC) s
 WHERE s.assessment_id = a."id" AND a."owner_email" IS NULL;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_grants_live_unq" ON "access_grants" USING btree ("grantee_email","scope_kind","scope_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_grants_grantee_email_idx" ON "access_grants" USING btree ("grantee_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assessments_owner_email_idx" ON "assessments" USING btree ("owner_email");