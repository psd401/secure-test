CREATE TABLE IF NOT EXISTS "scoring_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"provider_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"filter" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "scoring_runs_label_unique" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "scores" DROP CONSTRAINT "scores_status_check";--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "rubric_snapshot" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_run_id_scoring_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scoring_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scores_run_id_idx" ON "scores" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_status_check" CHECK (status IN ('proposed', 'final', 'research'));