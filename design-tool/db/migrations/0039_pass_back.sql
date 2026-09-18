ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_kind_check";--> statement-breakpoint
ALTER TABLE "scores" DROP CONSTRAINT "scores_status_check";--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "pass_back_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error', 'time_expired', 'sitting_closed', 'teacher_hand_in', 'deadline_extended', 'passed_back'));--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_status_check" CHECK (status IN ('proposed', 'final', 'research', 'superseded'));