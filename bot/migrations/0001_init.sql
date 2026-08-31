CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE facts (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE TABLE conversations (
  chat_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  submission_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  question TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_to_id INTEGER,
  assigned_to_name TEXT,
  student_chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_delivery ON leads(delivery_status);

CREATE TABLE lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  event TEXT NOT NULL,
  actor_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
