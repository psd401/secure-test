CREATE TABLE IF NOT EXISTS "staff_preferences" (
	"staff_sub" text PRIMARY KEY NOT NULL,
	"new_authoring" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
