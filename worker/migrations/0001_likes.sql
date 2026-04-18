-- Single table: each row is a slug and its cumulative like count.
-- Slugs match the filename base (without extension) used in memes/<slug>.toml.

CREATE TABLE IF NOT EXISTS likes (
  slug  TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
