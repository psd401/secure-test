CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_owner_sub_sha256_unq" UNIQUE("owner_sub","sha256")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_owner_sub_idx" ON "assets" USING btree ("owner_sub");