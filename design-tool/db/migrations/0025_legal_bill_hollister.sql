CREATE TABLE IF NOT EXISTS "item_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"stimulus_text" text DEFAULT '' NOT NULL,
	"layout" text DEFAULT 'inline' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_sets_layout_check" CHECK ("item_sets"."layout" in ('inline', 'own_page'))
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "item_set_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_sets" ADD CONSTRAINT "item_sets_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_sets_assessment_id_idx" ON "item_sets" USING btree ("assessment_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_item_set_id_item_sets_id_fk" FOREIGN KEY ("item_set_id") REFERENCES "public"."item_sets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
