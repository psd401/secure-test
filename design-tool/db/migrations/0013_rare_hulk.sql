CREATE TABLE IF NOT EXISTS "test_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"owner_sub" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_sessions_status_check" CHECK (status IN ('open', 'closed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_sessions_assessment_id_idx" ON "test_sessions" USING btree ("assessment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_sessions_owner_sub_idx" ON "test_sessions" USING btree ("owner_sub");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "test_sessions_open_code_unq" ON "test_sessions" USING btree ("code") WHERE status = 'open';