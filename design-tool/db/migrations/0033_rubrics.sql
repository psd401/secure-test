CREATE TABLE IF NOT EXISTS "rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"title" text NOT NULL,
	"rubric" jsonb NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rubrics_source_check" CHECK (source IN ('upload', 'editor'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubrics_owner_sub_idx" ON "rubrics" USING btree ("owner_sub");