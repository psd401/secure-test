ALTER TABLE "item_sets" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_sets" ADD CONSTRAINT "item_sets_source_item_id_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
