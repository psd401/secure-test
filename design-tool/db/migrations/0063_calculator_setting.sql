ALTER TABLE "assessments" ADD COLUMN "calculator_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "calculator_preset" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_calculator_mode_check" CHECK (calculator_mode IN ('none', 'four_function', 'scientific', 'graphing'));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_calculator_preset_check" CHECK (calculator_preset IN ('full', 'state_wa'));