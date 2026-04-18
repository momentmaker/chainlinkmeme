-- Multi-axis reactions: heart, laugh, bolt, diamond per slug. The existing
-- `likes` table stays in place (worker reads it as the "heart" count via
-- UNION) so we preserve historical counts without a data migration.

CREATE TABLE IF NOT EXISTS reactions (
  slug     TEXT NOT NULL,
  reaction TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, reaction)
);

CREATE INDEX IF NOT EXISTS reactions_by_reaction ON reactions(reaction, count DESC);
