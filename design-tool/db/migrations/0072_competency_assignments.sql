CREATE TABLE IF NOT EXISTS "competency_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"student_ps_id" text NOT NULL,
	"item_set_id" uuid NOT NULL,
	"proctor_email" text NOT NULL,
	"assigned_by_sub" text NOT NULL,
	"assigned_by_email" text NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"result" text,
	"released_at" timestamp with time zone,
	"released_by_email" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_assignments_status_check" CHECK (status IN ('assigned', 'in_progress', 'handed_in', 'scored', 'released', 'withdrawn')),
	CONSTRAINT "competency_assignments_result_check" CHECK (result IS NULL OR result IN ('pass', 'needs_revision', 'no_score'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competency_assignments" ADD CONSTRAINT "competency_assignments_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competency_assignments" ADD CONSTRAINT "competency_assignments_student_ps_id_roster_students_ps_id_fk" FOREIGN KEY ("student_ps_id") REFERENCES "public"."roster_students"("ps_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competency_assignments" ADD CONSTRAINT "competency_assignments_item_set_id_item_sets_id_fk" FOREIGN KEY ("item_set_id") REFERENCES "public"."item_sets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "competency_assignments_live_unq" ON "competency_assignments" USING btree ("assessment_id","student_ps_id") WHERE status <> 'withdrawn';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competency_assignments_proctor_email_idx" ON "competency_assignments" USING btree ("proctor_email");