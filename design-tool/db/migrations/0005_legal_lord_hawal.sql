CREATE TABLE IF NOT EXISTS "assessment_student_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"value" text NOT NULL,
	"created_by_sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_student_overrides_triple_unq" UNIQUE("assessment_id","student_id","tool_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_student_overrides" ADD CONSTRAINT "assessment_student_overrides_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_student_overrides" ADD CONSTRAINT "assessment_student_overrides_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assessment_student_overrides_assessment_id_idx" ON "assessment_student_overrides" USING btree ("assessment_id");