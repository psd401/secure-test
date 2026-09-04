CREATE TABLE IF NOT EXISTS "attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb,
	CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attempt_events_attempt_id_idx" ON "attempt_events" USING btree ("attempt_id");