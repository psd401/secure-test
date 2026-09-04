CREATE TABLE IF NOT EXISTS "peek_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"image_base64" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peek_requests" ADD CONSTRAINT "peek_requests_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peek_requests_attempt_id_idx" ON "peek_requests" USING btree ("attempt_id");