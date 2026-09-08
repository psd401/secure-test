CREATE TABLE IF NOT EXISTS "attempt_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"deleted_by_sub" text NOT NULL,
	"attempt_status" text NOT NULL,
	"attempt_started_at" timestamp with time zone NOT NULL,
	"attempt_submitted_at" timestamp with time zone,
	"response_count" integer NOT NULL,
	"upload_count" integer NOT NULL,
	"event_count" integer NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attempt_deletions" ADD CONSTRAINT "attempt_deletions_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attempt_deletions" ADD CONSTRAINT "attempt_deletions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attempt_deletions_assessment_id_idx" ON "attempt_deletions" USING btree ("assessment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attempt_deletions_deleted_at_idx" ON "attempt_deletions" USING btree ("deleted_at");