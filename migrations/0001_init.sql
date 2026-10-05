CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position REAL NOT NULL
);
CREATE INDEX columns_board ON columns(board_id, position);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT, -- YYYY-MM-DD, so string comparison orders correctly
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_column ON tasks(column_id, position);
CREATE INDEX tasks_due ON tasks(due_date);

CREATE TABLE subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL
);
CREATE INDEX subtasks_task ON subtasks(task_id, position);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX labels_board_name ON labels(board_id, name COLLATE NOCASE);

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
