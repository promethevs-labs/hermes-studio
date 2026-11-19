-- Eval records: a learner's ratings of assets (`asset_rating`, an
-- append-only log, state), what a video was made of (`asset_ingredients`,
-- derived from its source), and two JSON columns on `job`: `run`, the
-- runner's record of how it ran, and `review`, a person's verdict detail.
--
-- The two `job` columns are a plain ADD COLUMN with no CHECK. drizzle-kit
-- writes any CHECK on `job` as a rebuild of the whole table, which this
-- migration must not do to the owner's jobs; `checkJobRun` and
-- `checkJobReview` hold the shapes in the writer instead.
--
-- drizzle-kit's own output is everything between this header and the block
-- at the end, with one cut: it also wrote a rebuild of `asset`, because
-- 0004 was written by hand with no snapshot, so the diff ran against 0003's
-- snapshot and its old `asset_source_repo_check`. 0004 already made that
-- change, and this file's snapshot holds the schema as it is now, so the
-- rebuild is left out and the next generate will not write it again. The
-- block at the end is the copy guard every table carries, as three row
-- triggers (test/content-seam.test.ts fails a table without them).
CREATE TABLE `asset_ingredients` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'local' NOT NULL,
	`tool` text NOT NULL,
	`scanner_version` integer NOT NULL,
	`source_hash` text NOT NULL,
	`scene_count` integer,
	`duration_seconds` real,
	`calls` text NOT NULL,
	`metrics` text NOT NULL,
	`computed_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `learner`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "asset_ingredients_tool_check" CHECK(length(tool) between 1 and 64),
	CONSTRAINT "asset_ingredients_scanner_version_check" CHECK(scanner_version >= 1),
	CONSTRAINT "asset_ingredients_source_hash_check" CHECK(length(source_hash) between 1 and 128),
	CONSTRAINT "asset_ingredients_scene_count_check" CHECK(scene_count is null or scene_count >= 0),
	CONSTRAINT "asset_ingredients_duration_check" CHECK(duration_seconds is null or duration_seconds >= 0),
	CONSTRAINT "asset_ingredients_calls_check" CHECK(json_valid(calls) and json_type(calls) = 'object'),
	CONSTRAINT "asset_ingredients_metrics_check" CHECK(json_valid(metrics) and json_type(metrics) = 'object')
);
--> statement-breakpoint
CREATE INDEX `asset_ingredients_owner_id_idx` ON `asset_ingredients` (`owner_id`);--> statement-breakpoint
CREATE TABLE `asset_rating` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`value` integer NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`note` text,
	`surface` text NOT NULL,
	`job_id` text,
	`asset_hash` text,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "asset_rating_value_check" CHECK(value in (-1, 0, 1)),
	CONSTRAINT "asset_rating_tags_check" CHECK(json_valid(tags) and json_type(tags) = 'array' and json_array_length(tags) <= 8),
	CONSTRAINT "asset_rating_clear_check" CHECK(value <> 0 or tags = '[]'),
	CONSTRAINT "asset_rating_note_check" CHECK(note is null or (length(note) between 1 and 2000 and note = trim(note))),
	CONSTRAINT "asset_rating_surface_check" CHECK(surface in ('library', 'studio'))
);
--> statement-breakpoint
CREATE INDEX `asset_rating_learner_asset_at_idx` ON `asset_rating` (`learner_id`,`asset_id`,`at`);--> statement-breakpoint
CREATE INDEX `asset_rating_asset_id_idx` ON `asset_rating` (`asset_id`);--> statement-breakpoint
ALTER TABLE `job` ADD `run` text;--> statement-breakpoint
ALTER TABLE `job` ADD `review` text;
--> statement-breakpoint
CREATE TRIGGER `asset_ingredients_copy_guard_ins` BEFORE INSERT ON `asset_ingredients` FOR EACH ROW
	WHEN catalog_copy_ok() = 0 AND (SELECT `role` FROM `catalog_instance` WHERE `id`) = 'copy'
BEGIN
	SELECT RAISE(ABORT, '25006: this database is a copy, so writes are refused. Writes go to the primary (' || (select primary_host from catalog_instance where id) || ').');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_ingredients_copy_guard_upd` BEFORE UPDATE ON `asset_ingredients` FOR EACH ROW
	WHEN catalog_copy_ok() = 0 AND (SELECT `role` FROM `catalog_instance` WHERE `id`) = 'copy'
BEGIN
	SELECT RAISE(ABORT, '25006: this database is a copy, so writes are refused. Writes go to the primary (' || (select primary_host from catalog_instance where id) || ').');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_ingredients_copy_guard_del` BEFORE DELETE ON `asset_ingredients` FOR EACH ROW
	WHEN catalog_copy_ok() = 0 AND (SELECT `role` FROM `catalog_instance` WHERE `id`) = 'copy'
BEGIN
	SELECT RAISE(ABORT, '25006: this database is a copy, so writes are refused. Writes go to the primary (' || (select primary_host from catalog_instance where id) || ').');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_rating_copy_guard_ins` BEFORE INSERT ON `asset_rating` FOR EACH ROW
	WHEN catalog_copy_ok() = 0 AND (SELECT `role` FROM `catalog_instance` WHERE `id`) = 'copy'
BEGIN
	SELECT RAISE(ABORT, '25006: this database is a copy, so writes are refused. Writes go to the primary (' || (select primary_host from catalog_instance where id) || ').');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_rating_copy_guard_upd` BEFORE UPDATE ON `asset_rating` FOR EACH ROW
	WHEN catalog_copy_ok() = 0 AND (SELECT `role` FROM `catalog_instance` WHERE `id`) = 'copy'
BEGIN
	SELECT RAISE(ABORT, '25006: this database is a copy, so writes are refused. Writes go to the primary (' || (select primary_host from catalog_instance where id) || ').');
END;
--> statement-breakpoint
CREATE TRIGGER `asset_rating_copy_guard_del` BEFORE DELETE ON `asset_rating` FOR EACH ROW
	WHEN catalog_copy_ok() = 0 AND (SELECT `role` FROM `catalog_instance` WHERE `id`) = 'copy'
BEGIN
	SELECT RAISE(ABORT, '25006: this database is a copy, so writes are refused. Writes go to the primary (' || (select primary_host from catalog_instance where id) || ').');
END;
