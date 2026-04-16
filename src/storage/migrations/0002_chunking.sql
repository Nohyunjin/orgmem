CREATE TABLE `node_chunks` (
	`chunk_id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`chunk_idx` integer NOT NULL,
	`heading` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`embedding_error` text,
	`embedding_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `node_chunks_node_id_idx` ON `node_chunks` (`node_id`);--> statement-breakpoint
CREATE INDEX `node_chunks_embedding_status_idx` ON `node_chunks` (`embedding_status`);