CREATE TABLE IF NOT EXISTS "google_doc_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"scope_key" text NOT NULL,
	"assessment_id" uuid,
	"drive_folder_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_doc_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"sender_sub" text NOT NULL,
	"drive_file_id" text NOT NULL,
	"title" text NOT NULL,
	"contents" jsonb NOT NULL,
	"was_draft" boolean DEFAULT false NOT NULL,
	"ownership_transferred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_doc_folders" ADD CONSTRAINT "google_doc_folders_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_doc_releases" ADD CONSTRAINT "google_doc_releases_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_doc_folders_owner_scope_unq" ON "google_doc_folders" USING btree ("owner_sub","scope_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_doc_releases_attempt_id_idx" ON "google_doc_releases" USING btree ("attempt_id");