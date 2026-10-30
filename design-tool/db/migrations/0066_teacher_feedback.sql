CREATE TABLE IF NOT EXISTS "attempt_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"author_sub" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_feedback_text_check" CHECK (char_length(text) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "response_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"author_sub" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_feedback_text_check" CHECK (char_length(text) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_kind_check";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attempt_feedback" ADD CONSTRAINT "attempt_feedback_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attempt_feedback_attempt_id_unq" ON "attempt_feedback" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "response_feedback_response_id_unq" ON "response_feedback" USING btree ("response_id");--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error', 'time_expired', 'sitting_closed', 'speech_preflight', 'teacher_hand_in', 'deadline_extended', 'passed_back', 'gradebook_sent', 'score_changed', 'feedback_shown', 'answer_restored', 'feedback_edited'));