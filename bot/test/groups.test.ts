import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { commitSchedule, previewSchedule, publicGroups } from "../src/groups";
import { DomainError } from "../src/booking-commands";
import { insertBooking, insertGroup, operationId, TEST_NOW, TEST_SECRET } from "./group-fixtures";

const db = (env as any).DB as D1Database;

describe("schedule preview", () => {
  it("строит три даты с интервалом 14 дней для примера владельца", async () => {
    const preview = await previewSchedule(db, {
      action: "create",
      expectedRevision: 1,
      firstDate: "2026-09-21",
      startTime: "19:00",
      count: 3,
      capacity: 12,
    }, new Date("2026-09-12T08:00:00.000Z"));
    expect(preview.changes.map((change) => change.newDate)).toEqual([
      "2026-09-21",
      "2026-10-05",
      "2026-10-19",
    ]);
    expect(preview.changes.every((change) => change.newDateStatus === "planned")).toBe(true);
  });

  it("отклоняет несуществующую календарную дату", async () => {
    await expect(previewSchedule(db, {
      action: "create",
      expectedRevision: 1,
      firstDate: "2030-02-29",
      startTime: "19:00",
      count: 1,
      capacity: 12,
    }, TEST_NOW)).rejects.toMatchObject({ code: "invalid_date" } satisfies Partial<DomainError>);
  });
});

describe("schedule commit", () => {
  it("создаёт группы один раз и replay не зависит от новой schedule revision", async () => {
    const key = operationId("schedule-create");
    const command = {
      action: "create" as const,
      expectedRevision: 1,
      firstDate: "2030-02-01",
      startTime: "19:00",
      count: 3,
      capacity: 12,
    };
    const first = await commitSchedule(db, command, key, "admin-1", TEST_SECRET, TEST_NOW);
    const retry = await commitSchedule(db, command, key, "admin-1", TEST_SECRET, TEST_NOW);
    expect(first.replayed).toBe(false);
    expect(retry).toEqual({ replayed: true, result: first.result });
    expect(new Set(first.result.changes.map((change) => change.id)).size).toBe(3);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM groups").first<{ count: number }>();
    expect(count?.count).toBe(3);
    expect((await publicGroups(db, TEST_NOW)).scheduleRevision).toBe(2);
  });

  it("сдвигает +14 и -14 в безопасном порядке с теми же id", async () => {
    const firstId = await insertGroup(db, { sequence: 1, startDate: "2030-03-01" });
    const secondId = await insertGroup(db, { sequence: 2, startDate: "2030-03-15" });
    const forward = await commitSchedule(db, {
      action: "move",
      expectedRevision: 1,
      groupId: firstId,
      newDate: "2030-03-15",
      newTime: "19:00",
      scope: "following_planned",
      ackConfirmedMove: false,
    }, operationId("move-forward"), "admin-1", TEST_SECRET, TEST_NOW);
    expect(forward.result.changes.map((change) => [change.id, change.newDate])).toEqual([
      [firstId, "2030-03-15"],
      [secondId, "2030-03-29"],
    ]);
    const backward = await commitSchedule(db, {
      action: "move",
      expectedRevision: 2,
      groupId: firstId,
      newDate: "2030-03-01",
      newTime: "19:00",
      scope: "following_planned",
      ackConfirmedMove: false,
    }, operationId("move-backward"), "admin-1", TEST_SECRET, TEST_NOW);
    expect(backward.result.changes.map((change) => [change.id, change.newDate])).toEqual([
      [firstId, "2030-03-01"],
      [secondId, "2030-03-15"],
    ]);
  });

  it("блокирует каскад при следующей confirmed группе без частичных изменений", async () => {
    const firstId = await insertGroup(db, { sequence: 1, startDate: "2030-04-01" });
    await insertGroup(db, { sequence: 2, startDate: "2030-04-15", dateStatus: "confirmed" });
    await expect(commitSchedule(db, {
      action: "move",
      expectedRevision: 1,
      groupId: firstId,
      newDate: "2030-04-08",
      newTime: "19:00",
      scope: "following_planned",
      ackConfirmedMove: false,
    }, operationId("confirmed-conflict"), "admin-1", TEST_SECRET, TEST_NOW)).rejects.toMatchObject({ code: "confirmed_conflict" });
    const rows = await db.prepare("SELECT start_date FROM groups ORDER BY sequence").all<{ start_date: string }>();
    expect(rows.results.map((row) => row.start_date)).toEqual(["2030-04-01", "2030-04-15"]);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>())?.count).toBe(0);
  });

  it("создаёт отдельное уведомление каждому ученику при переносе", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-05-01" });
    await insertBooking(db, { groupId, phone: "+995599000011" });
    await insertBooking(db, { groupId, phone: "+995599000012" });
    await commitSchedule(db, {
      action: "move",
      expectedRevision: 1,
      groupId,
      newDate: "2030-05-08",
      newTime: "19:00",
      scope: "one",
      ackConfirmedMove: false,
    }, operationId("move-notify"), "admin-1", TEST_SECRET, TEST_NOW);
    const notifications = await db.prepare(
      "SELECT recipient_key FROM outbox WHERE event_type = 'group_moved' ORDER BY recipient_key",
    ).all<{ recipient_key: string }>();
    expect(notifications.results).toHaveLength(2);
    expect(new Set(notifications.results.map((row) => row.recipient_key)).size).toBe(2);
  });

  it("при двух правках одной revision сохраняет только одну", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-06-01" });
    const command = (newDate: string) => ({
      action: "move" as const,
      expectedRevision: 1,
      groupId,
      newDate,
      newTime: "19:00",
      scope: "one" as const,
      ackConfirmedMove: false,
    });
    const attempts = await Promise.allSettled([
      commitSchedule(db, command("2030-06-08"), operationId("writer-a"), "admin-a", TEST_SECRET, TEST_NOW),
      commitSchedule(db, command("2030-06-15"), operationId("writer-b"), "admin-b", TEST_SECRET, TEST_NOW),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "schedule_changed", status: 409 });
    expect((await db.prepare("SELECT revision FROM schedule_state WHERE service_id = 'theory_group'")
      .first<{ revision: number }>())?.revision).toBe(2);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?")
      .bind(groupId).first<{ count: number }>())?.count).toBe(1);
  });
});
