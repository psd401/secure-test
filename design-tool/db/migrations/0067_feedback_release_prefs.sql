CREATE TABLE IF NOT EXISTS "feedback_release_prefs" (
	"staff_sub" text NOT NULL,
	"assessment_id" uuid NOT NULL,
	"contents" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_release_prefs_staff_sub_assessment_id_pk" PRIMARY KEY("staff_sub","assessment_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_release_prefs" ADD CONSTRAINT "feedback_release_prefs_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
