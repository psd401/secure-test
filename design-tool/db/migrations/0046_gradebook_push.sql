CREATE TABLE IF NOT EXISTS "gradebook_push_scores" (
	"push_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"external_score_id" text,
	"points_sent" double precision NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gradebook_push_scores_push_id_attempt_id_pk" PRIMARY KEY("push_id","attempt_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gradebook_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"section_ps_id" text NOT NULL,
	"target" text NOT NULL,
	"external_assignment_id" text,
	"external_section_id" text,
	"category_id" text,
	"name" text NOT NULL,
	"created_by_sub" text NOT NULL,
	"actor_sub" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_result" jsonb,
	"archived_at" timestamp with time zone,
	CONSTRAINT "gradebook_pushes_target_check" CHECK (target IN ('powerschool', 'schoology'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gradebook_section_prefs" (
	"staff_sub" text NOT NULL,
	"section_ps_id" text NOT NULL,
	"target" text NOT NULL,
	"category_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gradebook_section_prefs_staff_sub_section_ps_id_pk" PRIMARY KEY("staff_sub","section_ps_id"),
	CONSTRAINT "gradebook_section_prefs_target_check" CHECK (target IN ('powerschool', 'schoology'))
);
--> statement-breakpoint
ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_kind_check";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gradebook_push_scores" ADD CONSTRAINT "gradebook_push_scores_push_id_gradebook_pushes_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."gradebook_pushes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gradebook_push_scores" ADD CONSTRAINT "gradebook_push_scores_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gradebook_pushes" ADD CONSTRAINT "gradebook_pushes_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gradebook_pushes_live_unq" ON "gradebook_pushes" USING btree ("assessment_id","section_ps_id","target") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gradebook_pushes_assessment_id_idx" ON "gradebook_pushes" USING btree ("assessment_id");--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error', 'time_expired', 'sitting_closed', 'teacher_hand_in', 'deadline_extended', 'passed_back', 'gradebook_sent'));