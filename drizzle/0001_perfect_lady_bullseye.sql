CREATE TABLE `task_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`task_title` text NOT NULL,
	`task_description` text,
	`priority` text,
	`agent_method` text,
	`agent_instructions` text,
	`tags` text,
	`context` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
