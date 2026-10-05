-- When the task entered a Done column (UTC ISO); NULL while it's open. Drives the stats page.
ALTER TABLE tasks ADD COLUMN done_at TEXT;
CREATE INDEX tasks_done_at ON tasks(done_at);
-- Best available guess for tasks finished before this column existed.
UPDATE tasks SET done_at = updated_at
WHERE column_id IN (SELECT id FROM columns WHERE trim(name) = 'Done' COLLATE NOCASE);
