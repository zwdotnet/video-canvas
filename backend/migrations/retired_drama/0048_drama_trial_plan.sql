-- 保留新分集的原文段落切点和试排稿，供后续写剧本沿用。
ALTER TABLE drama_episodes ADD COLUMN trial_plan jsonb NOT NULL DEFAULT '{}'::jsonb;
