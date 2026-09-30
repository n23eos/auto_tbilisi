-- Лимиты в D1 переживают новые изоляты Worker; IP хранится только как HMAC.
CREATE TABLE booking_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK(count >= 1),
  max_count INTEGER NOT NULL CHECK(max_count > 0),
  expires_at TEXT NOT NULL,
  CHECK(count <= max_count)
);
CREATE INDEX booking_rate_expiry ON booking_rate_limits(expires_at);
