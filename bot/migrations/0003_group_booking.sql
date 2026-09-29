PRAGMA defer_foreign_keys = true;

CREATE TABLE schedule_state (
  service_id TEXT PRIMARY KEY CHECK (service_id = 'theory_group'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO schedule_state (service_id) VALUES ('theory_group');

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL CHECK (service_id = 'theory_group'),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  start_date TEXT NOT NULL CHECK (
    length(start_date) = 10
    AND start_date = strftime('%Y-%m-%d', start_date)
  ),
  start_time TEXT NOT NULL CHECK (
    length(start_time) = 5
    AND start_time = strftime('%H:%M', start_time)
  ),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tbilisi' CHECK (timezone = 'Asia/Tbilisi'),
  starts_at_utc TEXT NOT NULL CHECK (
    starts_at_utc = strftime('%Y-%m-%dT%H:%M:00Z', start_date || ' ' || start_time, '-4 hours')
  ),
  date_status TEXT NOT NULL DEFAULT 'planned' CHECK (date_status IN ('planned', 'confirmed')),
  enrollment_open INTEGER NOT NULL DEFAULT 1 CHECK (enrollment_open IN (0, 1)),
  lifecycle TEXT NOT NULL DEFAULT 'scheduled' CHECK (lifecycle IN ('scheduled', 'cancelled', 'completed')),
  capacity INTEGER NOT NULL DEFAULT 12 CHECK (capacity BETWEEN 1 AND 100),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cancelled_at TEXT,
  completed_at TEXT,
  UNIQUE (service_id, sequence),
  CHECK (
    (lifecycle = 'scheduled' AND cancelled_at IS NULL AND completed_at IS NULL)
    OR (lifecycle = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (lifecycle = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_groups_scheduled_date
  ON groups(service_id, start_date)
  WHERE lifecycle = 'scheduled';
CREATE INDEX idx_groups_schedule ON groups(service_id, lifecycle, starts_at_utc);

CREATE TRIGGER groups_immutable_identity
BEFORE UPDATE OF id, service_id, sequence ON groups
WHEN NEW.id != OLD.id OR NEW.service_id != OLD.service_id OR NEW.sequence != OLD.sequence
BEGIN
  SELECT RAISE(ABORT, 'group_identity_immutable');
END;

CREATE TRIGGER groups_future_insert
BEFORE INSERT ON groups
WHEN NEW.lifecycle = 'scheduled' AND datetime(NEW.starts_at_utc) <= datetime('now')
BEGIN
  SELECT RAISE(ABORT, 'group_must_be_future');
END;

CREATE TRIGGER groups_future_update
BEFORE UPDATE OF starts_at_utc, lifecycle ON groups
WHEN NEW.lifecycle = 'scheduled'
  AND NEW.starts_at_utc IS NOT OLD.starts_at_utc
  AND datetime(NEW.starts_at_utc) <= datetime('now')
BEGIN
  SELECT RAISE(ABORT, 'group_must_be_future');
END;

CREATE TRIGGER groups_max_three_insert
BEFORE INSERT ON groups
WHEN NEW.lifecycle = 'scheduled'
  AND datetime(NEW.starts_at_utc) > datetime('now')
  AND (
    SELECT COUNT(*) FROM groups
    WHERE service_id = NEW.service_id
      AND lifecycle = 'scheduled'
      AND datetime(starts_at_utc) > datetime('now')
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'group_future_limit');
END;

CREATE TRIGGER groups_max_three_update
BEFORE UPDATE OF service_id, lifecycle, starts_at_utc ON groups
WHEN NEW.lifecycle = 'scheduled'
  AND datetime(NEW.starts_at_utc) > datetime('now')
  AND (
    SELECT COUNT(*) FROM groups
    WHERE service_id = NEW.service_id
      AND lifecycle = 'scheduled'
      AND datetime(starts_at_utc) > datetime('now')
      AND id != OLD.id
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'group_future_limit');
END;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  public_reference TEXT NOT NULL UNIQUE,
  group_id TEXT REFERENCES groups(id),
  name TEXT,
  phone TEXT,
  student_chat_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'site_form', 'site_chat', 'legacy')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled', 'completed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  consent_version TEXT NOT NULL CHECK (length(trim(consent_version)) > 0),
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  terminal_at TEXT,
  pii_erased_at TEXT,
  CHECK (group_id IS NOT NULL OR source = 'legacy'),
  CHECK (
    (pii_erased_at IS NULL
      AND name IS NOT NULL AND length(trim(name)) BETWEEN 1 AND 100
      AND phone IS NOT NULL AND length(phone) BETWEEN 8 AND 16
      AND substr(phone, 1, 1) = '+'
      AND substr(phone, 2) NOT GLOB '*[^0-9]*')
    OR (pii_erased_at IS NOT NULL AND name IS NULL AND phone IS NULL AND student_chat_id IS NULL)
  ),
  CHECK (
    (status IN ('pending', 'confirmed') AND terminal_at IS NULL)
    OR (status IN ('declined', 'cancelled', 'completed') AND terminal_at IS NOT NULL)
  )
);

CREATE INDEX idx_bookings_group_status ON bookings(group_id, status);
CREATE INDEX idx_bookings_phone ON bookings(phone);
CREATE INDEX idx_bookings_retention ON bookings(created_at, terminal_at);

CREATE TRIGGER bookings_immutable_identity
BEFORE UPDATE OF id, public_reference, source, consent_version, consent_at, created_at ON bookings
WHEN NEW.id != OLD.id
  OR NEW.public_reference != OLD.public_reference
  OR NEW.source != OLD.source
  OR NEW.consent_version != OLD.consent_version
  OR NEW.consent_at != OLD.consent_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'booking_identity_immutable');
END;

CREATE TRIGGER bookings_terminal_at_immutable
BEFORE UPDATE OF terminal_at ON bookings
WHEN OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at
BEGIN
  SELECT RAISE(ABORT, 'booking_terminal_at_immutable');
END;

CREATE TRIGGER bookings_terminal_status_immutable
BEFORE UPDATE OF status ON bookings
WHEN OLD.status IN ('declined', 'cancelled', 'completed') AND NEW.status != OLD.status
BEGIN
  SELECT RAISE(ABORT, 'booking_terminal_status_immutable');
END;

CREATE TRIGGER bookings_group_admission_insert
BEFORE INSERT ON bookings
WHEN NEW.source != 'legacy'
  AND NOT EXISTS (
    SELECT 1 FROM groups g
    WHERE g.id = NEW.group_id
      AND g.lifecycle = 'scheduled'
      AND g.enrollment_open = 1
      AND datetime(g.starts_at_utc) > datetime('now')
      AND g.capacity > (
        SELECT COUNT(*) FROM bookings b
        WHERE b.group_id = g.id AND b.status = 'confirmed'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'booking_group_unavailable');
END;

CREATE TRIGGER bookings_group_admission_update
BEFORE UPDATE OF group_id, status ON bookings
WHEN NEW.status IN ('pending', 'confirmed')
  AND (NEW.group_id IS NOT OLD.group_id OR NEW.status = 'confirmed' AND OLD.status != 'confirmed')
  AND NOT EXISTS (
    SELECT 1 FROM groups g
    WHERE g.id = NEW.group_id
      AND g.lifecycle = 'scheduled'
      AND g.enrollment_open = 1
      AND datetime(g.starts_at_utc) > datetime('now')
      AND g.capacity > (
        SELECT COUNT(*) FROM bookings b
        WHERE b.group_id = g.id AND b.status = 'confirmed' AND b.id != NEW.id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'booking_group_unavailable');
END;

CREATE TRIGGER groups_capacity_not_below_confirmed
BEFORE UPDATE OF capacity ON groups
WHEN NEW.capacity < (
  SELECT COUNT(*) FROM bookings WHERE group_id = OLD.id AND status = 'confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'group_capacity_below_confirmed');
END;

CREATE TABLE command_results (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 16 AND 128),
  scope TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_code TEXT NOT NULL,
  entity_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (julianday(expires_at) <= julianday(created_at) + 1.000001)
);

CREATE INDEX idx_command_results_expiry ON command_results(expires_at);

CREATE TABLE command_guards (
  operation_id TEXT PRIMARY KEY,
  expected_revision INTEGER NOT NULL,
  actual_revision INTEGER NOT NULL,
  CHECK (expected_revision = actual_revision)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'booking', 'schedule', 'notification')),
  entity_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_state TEXT CHECK (old_state IS NULL OR json_valid(old_state)),
  new_state TEXT CHECK (new_state IS NULL OR json_valid(new_state)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_entity_created ON audit_events(entity_id, created_at);
CREATE INDEX idx_audit_created ON audit_events(created_at);

CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL UNIQUE,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (julianday(expires_at) <= julianday(created_at) + 1.000001)
);

INSERT INTO conversations_new (
  id, chat_id, step, data, submission_id, revision, created_at, updated_at, expires_at
)
SELECT
  lower(hex(randomblob(16))), chat_id, step, data, submission_id, 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  CASE
    WHEN julianday(expires_at) IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHEN julianday(expires_at) > julianday('now', '+24 hours')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')
    ELSE expires_at
  END
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE TABLE inbox (
  update_id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at TEXT,
  lease_until TEXT,
  lease_token TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (julianday(payload_expires_at) <= julianday(created_at) + 1.000001),
  CHECK (julianday(expires_at) <= julianday(created_at) + 7.000001),
  CHECK ((lease_until IS NULL) = (lease_token IS NULL)),
  CHECK (payload IS NOT NULL OR chat_id IS NULL)
);

CREATE INDEX idx_inbox_state_retry ON inbox(state, retry_at);
CREATE INDEX idx_inbox_chat_update ON inbox(chat_id, update_id);
CREATE INDEX idx_inbox_expiry ON inbox(expires_at);

CREATE TABLE chat_leases (
  chat_id INTEGER PRIMARY KEY,
  lease_until TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  event_id TEXT NOT NULL,
  booking_id TEXT REFERENCES bookings(id),
  group_id TEXT REFERENCES groups(id),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  safe_template_id TEXT NOT NULL,
  conversation_revision INTEGER CHECK (conversation_revision IS NULL OR conversation_revision >= 1),
  booking_revision INTEGER CHECK (booking_revision IS NULL OR booking_revision >= 1),
  group_revision INTEGER CHECK (group_revision IS NULL OR group_revision >= 1),
  recipient_key TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('student', 'staff', 'manual')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'sending', 'sent', 'failed', 'manual_contact', 'resolved', 'superseded')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at TEXT,
  lease_until TEXT,
  lease_token TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  terminal_at TEXT,
  resolved_at TEXT,
  resolved_by_actor TEXT,
  UNIQUE (event_id, recipient_role, recipient_key),
  CHECK ((lease_until IS NULL) = (lease_token IS NULL)),
  CHECK (
    state IN ('pending', 'sending')
    OR state = 'manual_contact'
    OR (state IN ('sent', 'failed', 'resolved', 'superseded') AND terminal_at IS NOT NULL)
  ),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX idx_outbox_state_retry ON outbox(state, retry_at);
CREATE INDEX idx_outbox_created ON outbox(created_at);
CREATE INDEX idx_outbox_booking ON outbox(booking_id);

CREATE TRIGGER outbox_terminal_at_immutable
BEFORE UPDATE OF terminal_at ON outbox
WHEN OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at
BEGIN
  SELECT RAISE(ABORT, 'outbox_terminal_at_immutable');
END;
