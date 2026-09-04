CREATE TABLE IF NOT EXISTS "guardrail_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"surface" text NOT NULL,
	"stage" text NOT NULL,
	"action" text NOT NULL,
	"provider_id" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text_snippet" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_events_surface_check" CHECK (surface IN ('item-gen', 'math-translate')),
	CONSTRAINT "guardrail_events_stage_check" CHECK (stage IN ('input', 'output')),
	CONSTRAINT "guardrail_events_action_check" CHECK (action IN ('allow', 'block'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_events_owner_sub_idx" ON "guardrail_events" USING btree ("owner_sub");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_events_created_at_idx" ON "guardrail_events" USING btree ("created_at");