ALTER TABLE "assessments" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "archived_at" timestamp with time zone;