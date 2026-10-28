CREATE TABLE IF NOT EXISTS saved_schedules (
    id UUID PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    schedule_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_saved_schedules_created_at
    ON saved_schedules (created_at DESC);
