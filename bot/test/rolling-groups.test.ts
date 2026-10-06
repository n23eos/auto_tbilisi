import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { commitSchedule } from "../src/groups";
import {
  maintainRollingSchedule,
  rollingScheduleConfig,
  rollingScheduleDates,
  type RollingScheduleConfig,
} from "../src/rolling-groups";
import { insertGroup, operationId, TEST_SECRET } from "./group-fixtures";

const db = (env as any).DB as D1Database;
const ROLLING_SECRET = "test-rolling-schedule-secret-0001";
const config: RollingScheduleConfig = {
  anchorDate: "2026-10-05",
  startTime: "19:00",
  capacity: 12,
  hmacSecret: ROLLING_SECRET,
};

describe("rolling schedule dates", () => {
  it("считает 19:00 Asia/Tbilisi точной границей будущего", () => {
    expect(rollingScheduleDates(new Date("2026-10-05T14:59:59.999Z"), config, 3)).toEqual([
      "2026-10-05",
      "2026-10-19",
      "2026-11-02",
    ]);
    expect(rollingScheduleDates(new Date("2026-10-05T15:00:00.000Z"), config, 3)).toEqual([
      "2026-10-19",
      "2026-11-02",
      "2026-11-16",
    ]);
  });

  it("сохраняет шаг 14 дней на границе года", () => {
    expect(rollingScheduleDates(new Date("2030-12-31T20:00:00.000Z"), config, 3)).toEqual([
      "2031-01-06",
      "2031-01-20",
      "2031-02-03",
    ]);
  });
});

describe("rolling schedule configuration", () => {
  it("сохраняет ручной режим без явного включения автоматизации", () => {
    expect(rollingScheduleConfig({ BOOKING_SECRET: ROLLING_SECRET })).toBeNull();
    expect(rollingScheduleConfig({ ROLLING_SCHEDULE_ENABLED: "false", BOOKING_SECRET: ROLLING_SECRET })).toBeNull();
  });

  it("использует подтвержденные значения по умолчанию", () => {
    expect(rollingScheduleConfig({ ROLLING_SCHEDULE_ENABLED: "true", BOOKING_SECRET: ROLLING_SECRET })).toEqual(config);
  });

  it.each([
    [{ ROLLING_SCHEDULE_ENABLED: "yes", BOOKING_SECRET: ROLLING_SECRET }, "rolling_schedule_invalid_enabled"],
    [{ ROLLING_SCHEDULE_ENABLED: "true" }, "rolling_schedule_secret_missing"],
    [{ ROLLING_SCHEDULE_ENABLED: "true", BOOKING_SECRET: ROLLING_SECRET, ROLLING_SCHEDULE_ANCHOR_DATE: "2030-02-29" }, "rolling_schedule_invalid_anchor"],
    [{ ROLLING_SCHEDULE_ENABLED: "true", BOOKING_SECRET: ROLLING_SECRET, ROLLING_SCHEDULE_START_TIME: "24:00" }, "rolling_schedule_invalid_time"],
    [{ ROLLING_SCHEDULE_ENABLED: "true", BOOKING_SECRET: ROLLING_SECRET, ROLLING_SCHEDULE_CAPACITY: "0" }, "rolling_schedule_invalid_capacity"],
  ])("отклоняет небезопасную частичную настройку", (input, code) => {
    expect(() => rollingScheduleConfig(input)).toThrow(code);
  });
});

describe("rolling schedule maintenance", () => {
  it("один раз создает три предварительные группы по 12 мест", async () => {
    const now = new Date("2030-01-01T08:00:00.000Z");
    const first = await maintainRollingSchedule(db, config, now);
    const ids = first.createdGroupIds;
    const before = await db.prepare(
      "SELECT id, start_date, start_time, date_status, capacity, revision FROM groups ORDER BY start_date",
    ).all<Record<string, unknown>>();
    const revision = await db.prepare(
      "SELECT revision FROM schedule_state WHERE service_id = 'theory_group'",
    ).first<{ revision: number }>();
    const auditCount = await db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>();

    const second = await maintainRollingSchedule(db, config, now);
    const after = await db.prepare(
      "SELECT id, start_date, start_time, date_status, capacity, revision FROM groups ORDER BY start_date",
    ).all<Record<string, unknown>>();

    expect(first.changed).toBe(true);
    expect(ids).toHaveLength(3);
    expect(before.results).toEqual([
      { id: ids[0], start_date: "2030-01-07", start_time: "19:00", date_status: "planned", capacity: 12, revision: 1 },
      { id: ids[1], start_date: "2030-01-21", start_time: "19:00", date_status: "planned", capacity: 12, revision: 1 },
      { id: ids[2], start_date: "2030-02-04", start_time: "19:00", date_status: "planned", capacity: 12, revision: 1 },
    ]);
    expect(second).toMatchObject({ changed: false, createdGroupIds: [], reservedSlots: [] });
    expect(after.results).toEqual(before.results);
    expect((await db.prepare("SELECT revision FROM schedule_state WHERE service_id = 'theory_group'").first<{ revision: number }>())?.revision)
      .toBe(revision?.revision);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>())?.count)
      .toBe(auditCount?.count);
  });

  it("устраняет дубли при конкурентных запусках cron", async () => {
    const now = new Date("2030-01-01T08:00:00.000Z");
    const results = await Promise.all([
      maintainRollingSchedule(db, config, now),
      maintainRollingSchedule(db, config, now),
    ]);
    const rows = await db.prepare("SELECT id, start_date FROM groups ORDER BY start_date").all();
    expect(rows.results).toHaveLength(3);
    expect(new Set(rows.results.map((row: any) => row.id)).size).toBe(3);
    expect(new Set(rows.results.map((row: any) => row.start_date)).size).toBe(3);
    const persistedIds = rows.results.map((row: any) => row.id);
    expect(results.some((result) => result.createdGroupIds.length === 3)).toBe(true);
    for (const result of results.filter((value) => value.createdGroupIds.length > 0)) {
      expect(result.createdGroupIds).toEqual(persistedIds);
    }
  });

  it("принимает три ручные группы без изменения бизнес-полей", async () => {
    const dates = ["2030-01-07", "2030-01-21", "2030-02-04"];
    const ids = await Promise.all(dates.map((startDate, index) => insertGroup(db, {
      id: `manual-${index + 1}`,
      sequence: index + 1,
      startDate,
      revision: 7,
      dateStatus: index === 0 ? "confirmed" : "planned",
      enrollmentOpen: index !== 1,
    })));
    const before = await db.prepare(
      "SELECT id, start_date, date_status, enrollment_open, revision FROM groups ORDER BY sequence",
    ).all();

    const result = await maintainRollingSchedule(db, config, new Date("2030-01-01T08:00:00.000Z"));
    const after = await db.prepare(
      "SELECT id, start_date, date_status, enrollment_open, revision FROM groups ORDER BY sequence",
    ).all();

    expect(result).toMatchObject({ changed: true, createdGroupIds: [] });
    expect(result.reservedSlots.map((slot) => slot.groupId)).toEqual(ids);
    expect(after.results).toEqual(before.results);
  });

  it("сохраняет перенесенные и отмененные позиции и заполняет следующие", async () => {
    await insertGroup(db, { id: "manual-past", sequence: 1, startDate: "2030-01-07" });
    await insertGroup(db, { id: "manual-cancelled", sequence: 2, startDate: "2030-01-21" });
    await insertGroup(db, { id: "manual-moved", sequence: 3, startDate: "2030-02-04" });
    const rows = await db.prepare("SELECT id, start_date FROM groups ORDER BY start_date").all<{ id: string; start_date: string }>();
    const cancelled = rows.results[1];
    const moved = rows.results[2];

    await commitSchedule(db, {
      action: "move",
      expectedRevision: 1,
      groupId: moved.id,
      newDate: "2030-02-05",
      newTime: "19:00",
      scope: "one",
      ackConfirmedMove: false,
    }, operationId("manual-move"), "admin-1", TEST_SECRET, new Date("2030-01-01T08:00:00.000Z"));
    await commitSchedule(db, {
      action: "cancel",
      expectedRevision: 2,
      groupId: cancelled.id,
    }, operationId("manual-cancel"), "admin-1", TEST_SECRET, new Date("2030-01-01T08:00:00.000Z"));
    // Триггеры SQLite используют часы runner, поэтому fixture завершает первую
    // группу до перевода внедренных доменных часов на 2030 год.
    await db.prepare(
      "UPDATE groups SET lifecycle = 'completed', enrollment_open = 0, completed_at = ? WHERE id = ?",
    ).bind("2030-01-07T15:00:00Z", rows.results[0].id).run();

    const result = await maintainRollingSchedule(db, config, new Date("2030-01-08T08:00:00.000Z"));
    const all = await db.prepare(
      "SELECT id, start_date, lifecycle FROM groups ORDER BY sequence",
    ).all<{ id: string; start_date: string; lifecycle: string }>();

    expect(result.createdGroupIds).toHaveLength(2);
    expect(all.results).toContainEqual({ id: rows.results[0].id, start_date: "2030-01-07", lifecycle: "completed" });
    expect(all.results).toContainEqual({ id: moved.id, start_date: "2030-02-05", lifecycle: "scheduled" });
    expect(all.results).toContainEqual({ id: cancelled.id, start_date: "2030-01-21", lifecycle: "cancelled" });
    expect(all.results.some((row) => row.id !== cancelled.id && row.start_date === "2030-01-21")).toBe(false);
    expect(all.results.some((row) => row.id !== moved.id && row.start_date === "2030-02-04")).toBe(false);
    expect(all.results.filter((row) => row.lifecycle === "scheduled" && row.start_date > "2030-01-08").map((row) => row.start_date))
      .toEqual(["2030-02-05", "2030-02-18", "2030-03-04"]);
  });

  it("не переоткрывает вторую календарную позицию после повторного переноса", async () => {
    const groupId = await insertGroup(db, {
      id: "moved-twice",
      sequence: 1,
      startDate: "2030-01-07",
    });
    await commitSchedule(db, {
      action: "move",
      expectedRevision: 1,
      groupId,
      newDate: "2030-01-21",
      newTime: "19:00",
      scope: "one",
      ackConfirmedMove: false,
    }, operationId("first-manual-move"), "admin-1", TEST_SECRET, new Date("2030-01-01T08:00:00.000Z"));
    await commitSchedule(db, {
      action: "move",
      expectedRevision: 2,
      groupId,
      newDate: "2030-01-22",
      newTime: "19:00",
      scope: "one",
      ackConfirmedMove: false,
    }, operationId("second-manual-move"), "admin-1", TEST_SECRET, new Date("2030-01-01T08:00:00.000Z"));

    await maintainRollingSchedule(db, config, new Date("2030-01-08T08:00:00.000Z"));
    const slots = await db.prepare(
      "SELECT slot_date, group_id FROM rolling_schedule_slots WHERE group_id = ? ORDER BY slot_date",
    ).bind(groupId).all<{ slot_date: string; group_id: string }>();
    const groups = await db.prepare(
      "SELECT id, start_date FROM groups ORDER BY start_date",
    ).all<{ id: string; start_date: string }>();

    expect(slots.results).toEqual([
      { slot_date: "2030-01-07", group_id: groupId },
      { slot_date: "2030-01-21", group_id: groupId },
    ]);
    expect(groups.results.some((row) => row.id !== groupId && row.start_date === "2030-01-21")).toBe(false);
    expect(groups.results.map((row) => row.start_date)).toEqual([
      "2030-01-22",
      "2030-02-04",
      "2030-02-18",
    ]);
  });
});
