CREATE TABLE IF NOT EXISTS "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"time_limit_seconds" integer,
	"allow_llm_authoring" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"stem" text NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correct_choice_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correct_answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_assessment_position_unq" UNIQUE("assessment_id","position")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assessments_owner_sub_idx" ON "assessments" USING btree ("owner_sub");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_assessment_id_idx" ON "items" USING btree ("assessment_id");