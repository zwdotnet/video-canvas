ALTER TABLE drama_episodes ADD COLUMN pending_storyboard jsonb NOT NULL DEFAULT '{}'::jsonb;
