-- 分集规划给每个剧情单元分配的时间预算。旧集没有计划预算，保持原有锁稿行为。
ALTER TABLE drama_episodes ADD COLUMN timing_budget jsonb NOT NULL DEFAULT '[]'::jsonb;
