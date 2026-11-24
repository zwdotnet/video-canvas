ALTER TABLE drama_projects ADD COLUMN outline_locked boolean NOT NULL DEFAULT false;

-- 已开始规划的项目继续沿用现有大纲与分集。
UPDATE drama_projects AS p
SET outline_locked = true
WHERE p.source_kind = 'novel' AND p.deleted_at IS NULL
  AND (p.plan_cursor > 0 OR EXISTS (
    SELECT 1 FROM drama_jobs AS j
    WHERE j.drama_id = p.id AND j.step IN ('plan', 'outline')
      AND j.status IN ('queued', 'running', 'succeeded') AND j.deleted_at IS NULL
  ));
