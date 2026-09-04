ALTER TABLE "students" DROP CONSTRAINT "students_owner_sub_classlink_sourced_id_unq";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN IF EXISTS "classlink_sourced_id";