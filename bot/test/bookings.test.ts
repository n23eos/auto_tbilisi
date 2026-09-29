import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bookingAction, createBooking, findBookingReplay, getBooking, listBookings } from "../src/bookings";
import { commitSchedule, patchGroup } from "../src/groups";
import { insertBooking, insertGroup, operationId, TEST_NOW, TEST_SECRET } from "./group-fixtures";

const db = (env as any).DB as D1Database;

function bookingInput(groupId: string, phone = "+995599100001") {
  return {
    groupId,
    groupRevision: 1,
    name: "Тестовый ученик",
    phone,
    consentVersion: "test-v1",
    source: "site_form" as const,
  };
}

describe("createBooking", () => {
  it("атомарно сохраняет заявку, audit и staff outbox", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-02-01" });
    const result = await createBooking(
      db,
      bookingInput(groupId),
      operationId("atomic-create"),
      TEST_SECRET,
      TEST_NOW,
    );
    expect(result.replayed).toBe(false);
    expect(result.result).toMatchObject({ status: "pending", groupId, contactMethod: "phone" });
    expect((await getBooking(db, result.result.id))?.phone).toBe("+995599100001");
    expect((await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?").bind(result.result.id).first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE booking_id = ?").bind(result.result.id).first<{ count: number }>())?.count).toBe(1);
  });

  it("replay возвращает ту же квитанцию, а другое тело отклоняет", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-02-15" });
    const key = operationId("booking-replay");
    const input = bookingInput(groupId);
    const first = await createBooking(db, input, key, TEST_SECRET, TEST_NOW);
    expect(await findBookingReplay(db, input, key, TEST_SECRET, TEST_NOW)).toEqual({
      replayed: true,
      result: first.result,
    });
    expect(await createBooking(db, input, key, TEST_SECRET, TEST_NOW)).toEqual({
      replayed: true,
      result: first.result,
    });
    await expect(createBooking(db, { ...input, phone: "+995599100002" }, key, TEST_SECRET, TEST_NOW))
      .rejects.toMatchObject({ code: "idempotency_mismatch", status: 409 });
  });

  it("истёкший key не создаёт вторую заявку", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-03-01" });
    const key = operationId("booking-expired");
    const input = bookingInput(groupId);
    await createBooking(db, input, key, TEST_SECRET, TEST_NOW);
    await db.prepare("UPDATE command_results SET expires_at = ? WHERE operation_id = ?")
      .bind("2030-01-01T07:59:59.000Z", key).run();
    await expect(createBooking(db, input, key, TEST_SECRET, TEST_NOW))
      .rejects.toMatchObject({ code: "idempotency_expired", status: 409 });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM bookings").first<{ count: number }>())?.count).toBe(1);
  });

  it("при изменении revision возвращает только публичные данные группы", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-03-15", revision: 2 });
    await expect(createBooking(db, bookingInput(groupId), operationId("stale-group"), TEST_SECRET, TEST_NOW))
      .rejects.toMatchObject({
        code: "group_changed",
        details: { group: { id: groupId, revision: 2, startDate: "2030-03-15" } },
      });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM bookings").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(0);
  });

  it("не принимает student_chat_id из web source", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-04-01" });
    await expect(createBooking(
      db,
      { ...bookingInput(groupId), studentChatId: 123 },
      operationId("spoof-chat"),
      TEST_SECRET,
      TEST_NOW,
    )).rejects.toMatchObject({ code: "spoofed_student_chat" });
  });

  it("не блокирует совпадение телефона и отмечает возможный дубль", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-04-15" });
    const first = await insertBooking(db, { groupId, phone: "+995599100010" });
    const second = await insertBooking(db, { groupId, phone: "+995599100010" });
    expect((await getBooking(db, first.result.id))?.possibleDuplicate).toBe(true);
    expect((await getBooking(db, second.result.id))?.possibleDuplicate).toBe(true);
  });

  it("проверяет lease fence и conversation revision в том же batch", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-04-29" });
    await db.prepare(
      `INSERT INTO chat_leases (chat_id, lease_until, lease_token, revision, updated_at)
       VALUES (7001, '2030-01-01T08:01:00.000Z', 'lease-current', 3, '2030-01-01T08:00:00.000Z')`,
    ).run();
    await db.prepare(
      `INSERT INTO conversations (
         id, chat_id, step, data, submission_id, revision, created_at, updated_at, expires_at
       ) VALUES ('conversation-1', 7001, 'consent', '{}', 'submission-1', 4,
                 '2030-01-01T08:00:00.000Z', '2030-01-01T08:00:00.000Z', '2030-01-01T09:00:00.000Z')`,
    ).run();
    await db.prepare(
      `INSERT INTO outbox (
         id, event_id, conversation_id, event_type, safe_template_id,
         conversation_revision, recipient_key, recipient_role, state,
         created_at, updated_at
       ) VALUES ('prompt-1', 'prompt-event-1', 'conversation-1', 'conversation_prompt',
                 'ask_consent', 4, 'conversation-1', 'student', 'pending',
                 '2030-01-01T08:00:00.000Z', '2030-01-01T08:00:00.000Z')`,
    ).run();
    const input = {
      ...bookingInput(groupId),
      source: "telegram" as const,
      studentChatId: 7001,
      conversation: { id: "conversation-1", revision: 4 },
      fence: { chatId: 7001, leaseToken: "lease-current", leaseRevision: 3 },
    };
    await createBooking(db, input, operationId("fenced-create"), TEST_SECRET, TEST_NOW);
    expect(await db.prepare("SELECT state FROM outbox WHERE id = 'prompt-1'").first()).toEqual({ state: "superseded" });
    expect(await db.prepare("SELECT revision, step FROM conversations WHERE id = 'conversation-1'").first()).toEqual({ revision: 5, step: "complete" });

    const stale = { ...input, phone: "+995599100099", conversation: { id: "conversation-1", revision: 5 }, fence: { ...input.fence, leaseToken: "stale" } };
    await expect(createBooking(db, stale, operationId("stale-fence"), TEST_SECRET, TEST_NOW))
      .rejects.toMatchObject({ code: "stale_lease" });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM bookings").first<{ count: number }>())?.count).toBe(1);
  });
});

describe("booking actions", () => {
  it("list и detail сохраняют revision архивной группы для admin action", async () => {
    await db.prepare(
      `INSERT INTO groups (
         id, service_id, sequence, start_date, start_time, starts_at_utc,
         lifecycle, enrollment_open, capacity, revision, created_at, updated_at, completed_at
       ) VALUES ('past-group', 'theory_group', 1, '2029-12-01', '19:00',
                 '2029-12-01T15:00:00Z', 'completed', 0, 12, 7,
                 '2029-01-01T00:00:00.000Z', '2029-12-01T17:00:00.000Z', '2029-12-01T17:00:00.000Z')`,
    ).run();
    await db.prepare(
      `INSERT INTO bookings (
         id, public_reference, group_id, name, phone, source, status, revision,
         consent_version, consent_at, created_at, updated_at, terminal_at
       ) VALUES ('past-booking', 'BK-PAST0000001', 'past-group', 'A', '+995599600001',
                 'legacy', 'completed', 3, 'legacy-v1', '2029-01-01T00:00:00.000Z',
                 '2029-01-01T00:00:00.000Z', '2029-12-01T17:00:00.000Z', '2029-12-01T17:00:00.000Z')`,
    ).run();
    expect((await getBooking(db, "past-booking"))?.groupRevision).toBe(7);
    const listed = await listBookings(db, { groupId: "past-group" });
    expect(listed.bookings).toHaveLength(1);
    expect(listed.bookings[0].groupRevision).toBe(7);
  });

  it("из 20 конкурентных confirm последнее место получает ровно один", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-05-01", capacity: 12 });
    for (let index = 0; index < 11; index += 1) {
      const created = await insertBooking(db, { groupId, phone: `+99559920${String(index).padStart(4, "0")}` });
      await bookingAction(db, created.result.id, {
        action: "confirm",
        expectedRevision: 1,
        groupRevision: 1,
      }, operationId(`seed-confirm-${index}`), "admin-1", TEST_SECRET, TEST_NOW);
    }
    const candidates = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      insertBooking(db, { groupId, phone: `+99559830${String(index).padStart(4, "0")}` })));
    const attempts = await Promise.allSettled(candidates.map((candidate, index) => bookingAction(
      db,
      candidate.result.id,
      { action: "confirm", expectedRevision: 1, groupRevision: 1 },
      operationId(`last-seat-${index}`),
      "admin-1",
      TEST_SECRET,
      TEST_NOW,
    )));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const count = await db.prepare(
      "SELECT COUNT(*) AS count FROM bookings WHERE group_id = ? AND status = 'confirmed'",
    ).bind(groupId).first<{ count: number }>();
    expect(count?.count).toBe(12);
  });

  it("transfer на полную группу откатывает booking, audit и outbox", async () => {
    const sourceId = await insertGroup(db, { sequence: 1, startDate: "2030-06-01" });
    const targetId = await insertGroup(db, { sequence: 2, startDate: "2030-06-15", capacity: 1 });
    const existing = await insertBooking(db, { groupId: targetId, phone: "+995599300001" });
    await bookingAction(db, existing.result.id, {
      action: "confirm", expectedRevision: 1, groupRevision: 1,
    }, operationId("fill-target"), "admin-1", TEST_SECRET, TEST_NOW);
    const moving = await insertBooking(db, { groupId: sourceId, phone: "+995599300002" });
    await bookingAction(db, moving.result.id, {
      action: "confirm", expectedRevision: 1, groupRevision: 1,
    }, operationId("confirm-moving"), "admin-1", TEST_SECRET, TEST_NOW);
    const auditBefore = (await db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>())!.count;
    const outboxBefore = (await db.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())!.count;
    await expect(bookingAction(db, moving.result.id, {
      action: "transfer",
      expectedRevision: 2,
      groupRevision: 1,
      targetGroupId: targetId,
      targetGroupRevision: 1,
    }, operationId("full-transfer"), "admin-1", TEST_SECRET, TEST_NOW))
      .rejects.toMatchObject({ code: "target_group_unavailable" });
    expect((await getBooking(db, moving.result.id))?.groupId).toBe(sourceId);
    expect((await getBooking(db, moving.result.id))?.revision).toBe(2);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>())?.count).toBe(auditBefore);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(outboxBefore);
  });

  it("terminal_at не меняется и terminal status не открывается", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-07-01" });
    const created = await insertBooking(db, { groupId });
    await bookingAction(db, created.result.id, {
      action: "decline", expectedRevision: 1, groupRevision: 1,
    }, operationId("decline"), "admin-1", TEST_SECRET, TEST_NOW);
    const terminalAt = (await getBooking(db, created.result.id))?.terminalAt;
    await expect(db.prepare(
      "UPDATE bookings SET terminal_at = '2031-01-01T00:00:00.000Z' WHERE id = ?",
    ).bind(created.result.id).run()).rejects.toThrow(/booking_terminal_at_immutable/);
    await expect(db.prepare("UPDATE bookings SET status = 'pending', terminal_at = NULL WHERE id = ?")
      .bind(created.result.id).run()).rejects.toThrow();
    expect((await getBooking(db, created.result.id))?.terminalAt).toBe(terminalAt);
  });

  it("отмена группы атомарно отменяет active bookings и создаёт уведомления", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-08-01" });
    const pending = await insertBooking(db, { groupId, phone: "+995599400001" });
    const confirmed = await insertBooking(db, { groupId, phone: "+995599400002" });
    await bookingAction(db, confirmed.result.id, {
      action: "confirm", expectedRevision: 1, groupRevision: 1,
    }, operationId("confirm-cancelled"), "admin-1", TEST_SECRET, TEST_NOW);
    await commitSchedule(db, {
      action: "cancel",
      expectedRevision: 1,
      groupId,
    }, operationId("cancel-group"), "admin-1", TEST_SECRET, TEST_NOW);
    expect((await getBooking(db, pending.result.id))?.status).toBe("cancelled");
    expect((await getBooking(db, confirmed.result.id))?.status).toBe("cancelled");
    expect((await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE event_type = 'group_cancelled'")
      .first<{ count: number }>())?.count).toBe(2);
  });

  it("patch capacity использует trigger и полностью откатывает команду", async () => {
    const groupId = await insertGroup(db, { sequence: 1, startDate: "2030-09-01", capacity: 3 });
    for (let index = 0; index < 2; index += 1) {
      const booking = await insertBooking(db, { groupId, phone: `+99559950000${index}` });
      await bookingAction(db, booking.result.id, {
        action: "confirm", expectedRevision: 1, groupRevision: 1,
      }, operationId(`capacity-confirm-${index}`), "admin-1", TEST_SECRET, TEST_NOW);
    }
    await expect(patchGroup(db, groupId, {
      expectedRevision: 1,
      expectedScheduleRevision: 1,
      capacity: 1,
    }, operationId("lower-capacity"), "admin-1", TEST_SECRET, TEST_NOW))
      .rejects.toBeTruthy();
    const group = await db.prepare("SELECT capacity, revision FROM groups WHERE id = ?").bind(groupId)
      .first<{ capacity: number; revision: number }>();
    expect(group).toEqual({ capacity: 3, revision: 1 });
    expect((await db.prepare("SELECT revision FROM schedule_state WHERE service_id = 'theory_group'")
      .first<{ revision: number }>())?.revision).toBe(1);
  });
});
