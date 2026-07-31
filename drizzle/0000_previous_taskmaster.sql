CREATE TABLE `calendar_sync` (
	`task_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`last_synced` text NOT NULL,
	`sync_direction` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `execution_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`method` text,
	`status` text,
	`output` text,
	`error` text,
	`log_path` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'inbox' NOT NULL,
	`priority` text DEFAULT 'p2' NOT NULL,
	`due` text,
	`calendar_event_id` text,
	`parent_id` text,
	`agent_executable` integer DEFAULT false NOT NULL,
	`agent_method` text DEFAULT 'human_only' NOT NULL,
	`agent_instructions` text,
	`agent_status` text DEFAULT 'pending' NOT NULL,
	`context` text,
	`tags` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
