CREATE TABLE IF NOT EXISTS "safeguarding_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid,
	"attempt_id" uuid,
	"assessment_id" uuid,
	"student_id" uuid,
	"item_id" uuid,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"confidence" real,
	"evidence" text DEFAULT '' NOT NULL,
	"detector" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_sub" text,
	"acknowledged_by_email" text,
	"ai_forced_at" timestamp with time zone,
	"ai_forced_by_sub" text,
	CONSTRAINT "safeguarding_alerts_kind_check" CHECK (kind IN ('wellbeing', 'prompt_injection')),
	CONSTRAINT "safeguarding_alerts_category_check" CHECK (category IN ('suicidal_ideation', 'self_harm', 'abuse', 'prompt_injection'))
);
--> statement-breakpoint
ALTER TABLE "responses" ADD COLUMN "safeguarding_screened_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safeguarding_alerts" ADD CONSTRAINT "safeguarding_alerts_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safeguarding_alerts" ADD CONSTRAINT "safeguarding_alerts_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safeguarding_alerts" ADD CONSTRAINT "safeguarding_alerts_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safeguarding_alerts" ADD CONSTRAINT "safeguarding_alerts_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safeguarding_alerts_response_id_idx" ON "safeguarding_alerts" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safeguarding_alerts_attempt_id_idx" ON "safeguarding_alerts" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safeguarding_alerts_assessment_id_idx" ON "safeguarding_alerts" USING btree ("assessment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safeguarding_alerts_created_at_idx" ON "safeguarding_alerts" USING btree ("created_at");