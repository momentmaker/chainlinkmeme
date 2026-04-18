-- Rolling rate-limit buckets keyed by ip + minute.
-- Rows age out naturally; we prune occasionally in application code
-- (or let D1 garbage collect via periodic DELETE in a cron trigger).

CREATE TABLE IF NOT EXISTS rate_limit (
  key  TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0
);
