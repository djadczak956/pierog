-- repeat: JSON recurrence rule (see Repeat in src/schemas.ts), NULL = one-off.
-- spawned_id: the copy created when this task was finished, so it is only created once.
ALTER TABLE tasks ADD COLUMN repeat TEXT;
ALTER TABLE tasks ADD COLUMN spawned_id TEXT;
