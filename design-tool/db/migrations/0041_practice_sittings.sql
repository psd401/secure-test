ALTER TABLE "attempts" ADD COLUMN "practice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "practice_for_sub" text;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "kind" text DEFAULT 'class' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "practice_for_sub" text;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_owner_sub_practice_for_sub_unq" UNIQUE("owner_sub","practice_for_sub");--> statement-breakpoint
ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_kind_check" CHECK (kind IN ('class', 'practice'));--> statement-breakpoint
ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_practice_check" CHECK ((kind = 'practice') = (practice_for_sub IS NOT NULL) AND (kind = 'class' OR (section_ps_id IS NULL AND student_ps_ids IS NULL)));