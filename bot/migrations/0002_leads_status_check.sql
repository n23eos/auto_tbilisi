-- CHECK на leads.status и leads.delivery_status.
--
-- SQLite не умеет ALTER TABLE ADD CONSTRAINT, поэтому таблица пересобирается
-- по штатному рецепту SQLite: новая таблица → перенос строк → DROP старой →
-- переименование. Порядок колонок и их типы повторяют 0001 один в один,
-- меняются только два ограничения.
--
-- defer_foreign_keys откладывает проверку внешних ключей до конца транзакции:
-- lead_events.lead_id ссылается на leads(id), и без этого DROP TABLE leads
-- упал бы на живой базе с уже накопленными событиями. После RENAME ссылка
-- снова указывает на существующую таблицу, и проверка на коммите проходит.
PRAGMA defer_foreign_keys = true;

CREATE TABLE leads_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  question TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'contacted', 'closed')),
  assigned_to_id INTEGER,
  assigned_to_name TEXT,
  student_chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Колонки перечислены явно: SELECT * молча перепутал бы их местами,
-- если в 0001 когда-нибудь поменяется порядок.
INSERT INTO leads_new (
  id, submission_id, name, phone, question, status,
  assigned_to_id, assigned_to_name, student_chat_id, telegram_message_id,
  delivery_status, created_at, updated_at
)
SELECT
  id, submission_id, name, phone, question, status,
  assigned_to_id, assigned_to_name, student_chat_id, telegram_message_id,
  delivery_status, created_at, updated_at
FROM leads;

DROP TABLE leads;

ALTER TABLE leads_new RENAME TO leads;

-- Индексы удалились вместе со старой таблицей — создаём заново.
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_delivery ON leads(delivery_status);
