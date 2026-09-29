ALTER TABLE "access_grants" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
-- Grants made before this column existed were already on the teacher's home list;
-- only grants made from now on show "New".
UPDATE "access_grants" SET "seen_at" = "created_at";
