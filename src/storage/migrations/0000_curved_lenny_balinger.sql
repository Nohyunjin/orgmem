CREATE TABLE `edges` (
	`edge_id` text PRIMARY KEY NOT NULL,
	`src_id` text NOT NULL,
	`relation` text NOT NULL,
	`dst_id` text NOT NULL,
	`source_file` text,
	`source_line` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `edges_src_idx` ON `edges` (`src_id`);--> statement-breakpoint
CREATE INDEX `edges_dst_idx` ON `edges` (`dst_id`);--> statement-breakpoint
CREATE INDEX `edges_source_file_idx` ON `edges` (`source_file`);--> statement-breakpoint
CREATE INDEX `edges_relation_idx` ON `edges` (`relation`);--> statement-breakpoint
CREATE TABLE `node_embeddings` (
	`node_id` text NOT NULL,
	`model` text NOT NULL,
	`dim` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `model`)
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`content` text,
	`source_file` text,
	`frontmatter_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`mtime` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nodes_type_idx` ON `nodes` (`type`);--> statement-breakpoint
CREATE INDEX `nodes_source_file_idx` ON `nodes` (`source_file`);