CREATE TABLE IF NOT EXISTS properties (
  public_id TEXT PRIMARY KEY,
  homeowner_uid TEXT NOT NULL,
  homeowner_stream_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS active_property_per_homeowner
ON properties(homeowner_uid) WHERE revoked_at IS NULL;
