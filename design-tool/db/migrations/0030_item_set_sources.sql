ALTER TABLE "item_sets" DROP CONSTRAINT "item_sets_layout_check";--> statement-breakpoint
ALTER TABLE "item_sets" ADD COLUMN "sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "item_sets" ADD CONSTRAINT "item_sets_layout_check" CHECK ("item_sets"."layout" in ('inline', 'own_page', 'side_by_side'));