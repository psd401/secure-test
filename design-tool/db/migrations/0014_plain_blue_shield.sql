ALTER TABLE "attempts" ADD COLUMN "test_session_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attempts" ADD CONSTRAINT "attempts_test_session_id_test_sessions_id_fk" FOREIGN KEY ("test_session_id") REFERENCES "public"."test_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_assessment_student_unq" UNIQUE("assessment_id","student_id");