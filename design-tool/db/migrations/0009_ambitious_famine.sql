CREATE TABLE IF NOT EXISTS "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"method" text NOT NULL,
	"points" double precision NOT NULL,
	"max_points" double precision NOT NULL,
	"rationale" jsonb,
	"scorer" text NOT NULL,
	"status" text NOT NULL,
	"reviewed_by_sub" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_method_check" CHECK (method IN ('auto', 'ai', 'human')),
	CONSTRAINT "scores_status_check" CHECK (status IN ('proposed', 'final')),
	CONSTRAINT "scores_points_check" CHECK (points >= 0 AND max_points > 0 AND points <= max_points)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scores_response_id_idx" ON "scores" USING btree ("response_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scores_one_final_per_response_unq" ON "scores" USING btree ("response_id") WHERE status = 'final';