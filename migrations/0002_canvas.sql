-- One row per Canvas assignment ever imported. task_id goes NULL when the task is deleted,
-- which tells the sync not to re-create it.
CREATE TABLE canvas_items (
  uid TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  due_date TEXT NOT NULL -- as Canvas last reported it, so manual edits aren't overwritten
);
