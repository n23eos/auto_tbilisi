import sqlite3
from datetime import datetime, timezone
from pathlib import Path


MIGRATIONS = Path(__file__).parents[1] / "bot" / "migrations"


def test_remote_d1_trigger_guards_avoid_nested_select_case():
    migration = (MIGRATIONS / "0003_group_booking.sql").read_text()

    assert "SELECT CASE WHEN" not in migration
    assert migration.count("RAISE(ABORT, 'group_future_limit')") == 2
    assert migration.count("RAISE(ABORT, 'booking_group_unavailable')") == 2


def test_legacy_conversation_expiry_is_clamped_without_reviving_expired_rows():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for name in ("0001_init.sql", "0002_leads_status_check.sql"):
        db.executescript((MIGRATIONS / name).read_text())

    db.execute(
        """
        INSERT INTO conversations (chat_id, step, data, submission_id, expires_at)
        VALUES
          (101, 'name', '{}', 'future', datetime('now', '+48 hours')),
          (102, 'name', '{}', 'expired', datetime('now', '-1 hour')),
          (103, 'name', '{}', 'invalid', 'not-a-date')
        """
    )
    db.executescript((MIGRATIONS / "0003_group_booking.sql").read_text())

    rows = dict(db.execute("SELECT submission_id, expires_at FROM conversations"))
    now = datetime.now(timezone.utc).timestamp()
    future = datetime.fromisoformat(rows["future"].replace("Z", "+00:00")).timestamp()
    expired = datetime.fromisoformat(rows["expired"].replace("Z", "+00:00")).timestamp()
    invalid = datetime.fromisoformat(rows["invalid"].replace("Z", "+00:00")).timestamp()

    assert future <= now + 24 * 60 * 60 + 1
    assert expired < now
    assert invalid <= now + 1
