CREATE TABLE rolling_schedule_slots (
  service_id TEXT NOT NULL CHECK (service_id = 'theory_group'),
  slot_date TEXT NOT NULL CHECK (
    length(slot_date) = 10
    AND slot_date = strftime('%Y-%m-%d', slot_date)
  ),
  group_id TEXT REFERENCES groups(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (service_id, slot_date)
);
