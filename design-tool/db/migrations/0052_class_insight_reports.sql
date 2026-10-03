CREATE TABLE IF NOT EXISTS "class_insight_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"report" jsonb NOT NULL,
	"pseudonyms" jsonb NOT NULL,
	"item_ids" jsonb NOT NULL,
	"pack_hash" text NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"dropped_claims" integer DEFAULT 0 NOT NULL,
	"created_by_sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardrail_events" DROP CONSTRAINT "guardrail_events_surface_check";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "class_insight_reports" ADD CONSTRAINT "class_insight_reports_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "class_insight_reports_assessment_section_unq" ON "class_insight_reports" USING btree ("assessment_id","section_key");--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_surface_check" CHECK (surface IN ('item-gen', 'math-translate', 'essay-score', 'pdf-import', 'rubric-extract', 'tag-suggest', 'class-insights'));