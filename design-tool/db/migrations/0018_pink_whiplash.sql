CREATE TABLE IF NOT EXISTS "roster_enrollments" (
	"ps_id" text PRIMARY KEY NOT NULL,
	"student_ps_id" text NOT NULL,
	"section_ps_id" text NOT NULL,
	"dateenrolled" date NOT NULL,
	"dateleft" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_snapshot_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_section_teachers" (
	"section_ps_id" text NOT NULL,
	"teacher_ps_id" text NOT NULL,
	"teacher_email" text,
	"role_name" text DEFAULT '' NOT NULL,
	"priority_order" integer,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_snapshot_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "roster_section_teachers_section_ps_id_teacher_ps_id_start_date_pk" PRIMARY KEY("section_ps_id","teacher_ps_id","start_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_sections" (
	"ps_id" text PRIMARY KEY NOT NULL,
	"school_id" text,
	"course_code" text DEFAULT '' NOT NULL,
	"course_name" text DEFAULT '' NOT NULL,
	"term_id" text,
	"period_expression" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_snapshot_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_students" (
	"ps_id" text PRIMARY KEY NOT NULL,
	"ssid" text,
	"email" text,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"grade" text,
	"school_id" text,
	"enroll_status" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_snapshot_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "roster_sync_runs_status_check" CHECK (status IN ('running', 'succeeded', 'refused', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_enrollments" ADD CONSTRAINT "roster_enrollments_student_ps_id_roster_students_ps_id_fk" FOREIGN KEY ("student_ps_id") REFERENCES "public"."roster_students"("ps_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_enrollments" ADD CONSTRAINT "roster_enrollments_section_ps_id_roster_sections_ps_id_fk" FOREIGN KEY ("section_ps_id") REFERENCES "public"."roster_sections"("ps_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_section_teachers" ADD CONSTRAINT "roster_section_teachers_section_ps_id_roster_sections_ps_id_fk" FOREIGN KEY ("section_ps_id") REFERENCES "public"."roster_sections"("ps_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_enrollments_student_idx" ON "roster_enrollments" USING btree ("student_ps_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_enrollments_section_idx" ON "roster_enrollments" USING btree ("section_ps_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_section_teachers_email_idx" ON "roster_section_teachers" USING btree ("teacher_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_students_email_idx" ON "roster_students" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_students_ssid_idx" ON "roster_students" USING btree ("ssid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roster_sync_runs_started_at_idx" ON "roster_sync_runs" USING btree ("started_at");