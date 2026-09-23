ALTER TABLE "roster_section_teachers" ADD COLUMN "users_dcid" text;--> statement-breakpoint
ALTER TABLE "roster_sections" ADD COLUMN "dcid" text;--> statement-breakpoint
ALTER TABLE "roster_sections" ADD COLUMN "year_id" text;--> statement-breakpoint
ALTER TABLE "roster_students" ADD COLUMN "dcid" text;