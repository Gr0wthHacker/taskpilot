CREATE TABLE `cost_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_creation_tokens` integer,
	`cost_usd` real,
	`source` text,
	`third_party_label` text,
	`third_party_cost_usd` real,
	`at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text,
	`details` text,
	`at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
