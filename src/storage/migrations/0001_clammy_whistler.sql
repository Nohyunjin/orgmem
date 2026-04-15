ALTER TABLE `nodes` ADD `embedding_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `embedding_error` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `embedding_updated_at` integer;--> statement-breakpoint
CREATE INDEX `nodes_embedding_status_idx` ON `nodes` (`embedding_status`);