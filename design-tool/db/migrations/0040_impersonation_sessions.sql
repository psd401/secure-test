CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_sub" text NOT NULL,
	"actor_email" text NOT NULL,
	"target_sub" text NOT NULL,
	"target_email" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"request_id" text
);
