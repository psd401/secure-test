ALTER TABLE "items" ADD COLUMN "points" double precision;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_points_range" CHECK (points IS NULL OR (points > 0 AND points <= 100));