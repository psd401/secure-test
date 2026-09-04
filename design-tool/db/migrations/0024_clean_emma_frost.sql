CREATE TABLE IF NOT EXISTS "assessment_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"shared_by_sub" text NOT NULL,
	"shared_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"copied_assessment_id" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_shares" ADD CONSTRAINT "assessment_shares_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_shares" ADD CONSTRAINT "assessment_shares_copied_assessment_id_assessments_id_fk" FOREIGN KEY ("copied_assessment_id") REFERENCES "public"."assessments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assessment_shares_assessment_recipient_unq" ON "assessment_shares" USING btree ("assessment_id","recipient_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assessment_shares_recipient_email_idx" ON "assessment_shares" USING btree ("recipient_email");