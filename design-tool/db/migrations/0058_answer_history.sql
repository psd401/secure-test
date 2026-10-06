CREATE TABLE IF NOT EXISTS "response_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "response_revisions_reason_check" CHECK (reason IN ('interval', 'shrink', 'withdrawn', 'restored'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_revisions" ADD CONSTRAINT "response_revisions_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_revisions" ADD CONSTRAINT "response_revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "response_revisions_attempt_item_captured_idx" ON "response_revisions" USING btree ("attempt_id","item_id","captured_at");