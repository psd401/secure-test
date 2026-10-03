CREATE TABLE IF NOT EXISTS "class_insight_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"owner_sub" text NOT NULL,
	"section_key" text NOT NULL,
	"pseudonyms" jsonb NOT NULL,
	"item_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "class_insight_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"citations" jsonb DEFAULT '{"items":[],"tags":[],"students":[]}'::jsonb NOT NULL,
	"figures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_response_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pack_hash" text NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_insight_turns_role_check" CHECK (role IN ('teacher', 'assistant'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "class_insight_threads" ADD CONSTRAINT "class_insight_threads_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "class_insight_turns" ADD CONSTRAINT "class_insight_turns_thread_id_class_insight_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."class_insight_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "class_insight_threads_assessment_owner_section_unq" ON "class_insight_threads" USING btree ("assessment_id","owner_sub","section_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "class_insight_turns_thread_position_unq" ON "class_insight_turns" USING btree ("thread_id","position");