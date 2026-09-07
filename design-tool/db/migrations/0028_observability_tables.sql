CREATE TABLE IF NOT EXISTS "client_error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sub" text NOT NULL,
	"app_version" text NOT NULL,
	"app_commit" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sub" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"path" text NOT NULL,
	"message" text NOT NULL,
	"user_agent" text,
	"app_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text,
	"route" text NOT NULL,
	"method" text NOT NULL,
	"status" integer NOT NULL,
	"digest" text,
	"message" text NOT NULL,
	"stack_hash" text,
	"stack" text,
	"sub" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_kind_check";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_error_events_received_at_idx" ON "client_error_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_error_events_sub_idx" ON "client_error_events" USING btree ("sub");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_created_at_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "server_error_events_created_at_idx" ON "server_error_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "server_error_events_request_id_idx" ON "server_error_events" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error'));