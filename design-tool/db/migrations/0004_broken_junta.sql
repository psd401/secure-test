CREATE TABLE IF NOT EXISTS "student_accommodations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"tool_id" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"tide_code" text,
	"last_imported_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_accommodations_source_check" CHECK (source IN ('tide_import', 'tide_then_edited', 'manual'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"ssid" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"grade" text,
	"school" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_owner_sub_ssid_unq" UNIQUE("owner_sub","ssid")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "student_accommodations" ADD CONSTRAINT "student_accommodations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "student_accommodations_student_id_idx" ON "student_accommodations" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "student_accommodations_live_triple_unq" ON "student_accommodations" USING btree ("student_id","subject","tool_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_owner_sub_idx" ON "students" USING btree ("owner_sub");