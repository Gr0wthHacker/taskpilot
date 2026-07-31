CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`category` text DEFAULT 'note' NOT NULL,
	`text` text NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`link` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
