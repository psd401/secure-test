ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_kind_check";--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "student_feedback" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "answers_release" text DEFAULT 'on_release' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "answers_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_student_feedback_check" CHECK (student_feedback IN ('off', 'score', 'right_wrong', 'answers'));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_answers_release_check" CHECK (answers_release IN ('at_hand_in', 'on_release'));--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error', 'time_expired', 'sitting_closed', 'speech_preflight', 'teacher_hand_in', 'deadline_extended', 'passed_back', 'gradebook_sent', 'score_changed', 'feedback_shown'));