ALTER TABLE "students" ALTER COLUMN "ssid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "roster_ps_id" text;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "owner_email" text;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "section_ps_id" text;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD COLUMN "student_ps_ids" jsonb;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_owner_sub_roster_ps_id_unq" UNIQUE("owner_sub","roster_ps_id");