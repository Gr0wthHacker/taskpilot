CREATE TABLE `context_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`captured_at` text NOT NULL,
	`app_name` text,
	`window_title` text,
	`url` text,
	`page_title` text,
	`h1` text,
	`meta_description` text,
	`selection` text,
	`screenshot_path` text,
	`batch_id` text,
	`metadata` text,
	`workspace_id` text
);
--> statement-breakpoint
CREATE TABLE `deliberations` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`requested_at` text NOT NULL,
	`observation_ids` text NOT NULL,
	`trigger_reason` text NOT NULL,
	`status` text NOT NULL,
	`result_at` text,
	`interrupter_score` real,
	`waiter_score` real,
	`decision` text,
	`surfaced_as` text,
	`surfaced_id` text,
	`summary` text,
	`raw_result` text
);
--> statement-breakpoint
CREATE TABLE `recurring_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`recurrence_kind` text NOT NULL,
	`recurrence_interval` integer DEFAULT 1 NOT NULL,
	`next_fire_at` text NOT NULL,
	`last_fired_at` text,
	`fan_out_goal_id` text,
	`child_templates` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
