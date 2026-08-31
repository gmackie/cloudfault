CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payment_id TEXT,
  updated_at INTEGER NOT NULL
);
