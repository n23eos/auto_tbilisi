import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { dispatchOutbox, notificationAction } from "../src/outbox";
import { insertBooking, insertGroup } from "./group-fixtures";

const db = (env as any).DB as D1Database;

function workerEnv(fetchFn: typeof fetch) {
  return {
    ...(env as any),
    BOT_TOKEN: "test-token",
    ADMIN_CHAT_ID: "-100500",
    ADMIN_IDS: "7",
    ADMIN_ORIGIN: "https://admin.example.com",
    BOOKING_ENABLED: "true",
    __fetch: fetchFn,
  };
}

async function telegramBooking(label: string, chatId = 7001) {
  const groupId = await insertGroup(db, {
    id: `group-${label}`,
    sequence: Number(label.replace(/\D/g, "")) || 1,
    startDate: "2099-10-05",
  });
  const outcome = await insertBooking(db, {
    groupId,
    source: "telegram",
    studentChatId: chatId,
    name: "Секретное Имя",
    phone: "+995599000777",
  });
  return { groupId, booking: outcome.result };
}

async function keepOnlyStudent(bookingId: string) {
  await db
    .prepare(
      `UPDATE outbox
       SET state = 'superseded', terminal_at = datetime('now')
       WHERE booking_id = ? AND recipient_role != 'student'`,
    )
    .bind(bookingId)
    .run();
}

describe("outbox dispatcher", () => {
  it("доставляет staff карточку без PII и отдельную student квитанцию", async () => {
    const { booking } = await telegramBooking("1");
    const calls: any[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
    }) as unknown as typeof fetch;

    expect(await dispatchOutbox(workerEnv(fetchFn) as any)).toBe(2);
    expect(calls).toHaveLength(2);
    const staff = calls.find((call) => call.chat_id === -100500);
    expect(staff.text).toContain(booking.reference);
    expect(JSON.stringify(staff)).not.toContain("Секретное Имя");
    expect(JSON.stringify(staff)).not.toContain("+995599000777");
    const student = calls.find((call) => call.chat_id === 7001);
    expect(student.text).toContain("Ожидает подтверждения");
    const states = await db.prepare("SELECT state, provider_message_id FROM outbox ORDER BY recipient_role").all<any>();
    expect(states.results.every((row) => row.state === "sent")).toBe(true);
  });

  it("429 уважает retry_after и не считает сообщение отправленным", async () => {
    const { booking } = await telegramBooking("2", 7002);
    await keepOnlyStudent(booking.id);
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 120 } }),
      { status: 429 },
    )) as unknown as typeof fetch;

    expect(await dispatchOutbox(workerEnv(fetchFn) as any)).toBe(0);
    const row = await db
      .prepare("SELECT state, last_error_code, retry_at, attempts FROM outbox WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .first<any>();
    expect(row).toMatchObject({ state: "pending", last_error_code: "rate_limited", attempts: 1 });
    const seconds = (Date.parse(`${row.retry_at}Z`) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(115);
  });

  it("403 создает manual-contact без бесконечного retry", async () => {
    const { booking } = await telegramBooking("3", 7003);
    await keepOnlyStudent(booking.id);
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error_code: 403, description: "blocked" }),
      { status: 403 },
    )) as unknown as typeof fetch;

    await dispatchOutbox(workerEnv(fetchFn) as any);
    const row = await db
      .prepare("SELECT state, terminal_at, last_error_code FROM outbox WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .first<any>();
    expect(row).toEqual({ state: "manual_contact", terminal_at: null, last_error_code: "telegram_forbidden" });
  });

  it("crash после Telegram send оставляет lease и допускает повтор сообщения", async () => {
    const { booking } = await telegramBooking("4", 7004);
    await keepOnlyStudent(booking.id);
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { message_id: 44 } }),
    )) as unknown as typeof fetch;
    const e = workerEnv(fetchFn) as any;

    await expect(dispatchOutbox(e, {
      limit: 1,
      afterSend: async () => { throw new Error("crash_after_send"); },
    })).rejects.toThrow("crash_after_send");
    const sending = await db
      .prepare("SELECT state, lease_token FROM outbox WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .first<any>();
    expect(sending.state).toBe("sending");
    expect(sending.lease_token).toBeTruthy();

    await db
      .prepare("UPDATE outbox SET lease_until = datetime('now', '-1 second') WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .run();
    expect(await dispatchOutbox(e, { limit: 1 })).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("устаревшая booking revision superseded без отправки", async () => {
    const { booking } = await telegramBooking("5", 7005);
    await keepOnlyStudent(booking.id);
    await db.prepare("UPDATE bookings SET revision = revision + 1 WHERE id = ?").bind(booking.id).run();
    const fetchFn = vi.fn() as unknown as typeof fetch;

    await dispatchOutbox(workerEnv(fetchFn) as any);
    expect(fetchFn).not.toHaveBeenCalled();
    const row = await db
      .prepare("SELECT state, last_error_code FROM outbox WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .first<any>();
    expect(row).toEqual({ state: "superseded", last_error_code: "stale_version" });
  });

  it("manual-contact отмечается contacted без повтора бизнес-команды", async () => {
    const { booking } = await telegramBooking("6", 7006);
    await keepOnlyStudent(booking.id);
    await db
      .prepare(
        `UPDATE outbox SET state = 'manual_contact', retry_at = NULL
         WHERE booking_id = ? AND recipient_role = 'student'`,
      )
      .bind(booking.id)
      .run();
    const row = await db
      .prepare("SELECT id, revision FROM outbox WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .first<any>();
    const result = await notificationAction(
      db,
      row.id,
      { action: "contacted", expected_revision: row.revision },
      crypto.randomUUID(),
      "staff@example.com",
      "x".repeat(64),
    );
    expect(result).toMatchObject({ state: "resolved" });
    const saved = await db
      .prepare("SELECT state, resolved_by_actor, resolved_at, terminal_at FROM outbox WHERE id = ?")
      .bind(row.id)
      .first<any>();
    expect(saved.state).toBe("resolved");
    expect(saved.resolved_by_actor).toBe("staff@example.com");
    expect(saved.resolved_at).toBeTruthy();
    expect(saved.terminal_at).toBeTruthy();
  });

  it("failed после ручного retry и 403 снова становится видимой manual-contact задачей", async () => {
    const { booking } = await telegramBooking("7", 7007);
    await keepOnlyStudent(booking.id);
    await db
      .prepare(
        `UPDATE outbox SET state = 'failed', terminal_at = datetime('now'), last_error_code = 'retry_expired'
         WHERE booking_id = ? AND recipient_role = 'student'`,
      )
      .bind(booking.id)
      .run();
    const failed = await db
      .prepare("SELECT id, revision, terminal_at FROM outbox WHERE booking_id = ? AND recipient_role = 'student'")
      .bind(booking.id)
      .first<any>();
    await notificationAction(
      db,
      failed.id,
      { action: "retry", expected_revision: failed.revision },
      crypto.randomUUID(),
      "staff@example.com",
      "x".repeat(64),
    );
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error_code: 403 }),
      { status: 403 },
    )) as unknown as typeof fetch;

    await dispatchOutbox(workerEnv(fetchFn) as any, { limit: 1 });

    const row = await db
      .prepare("SELECT state, terminal_at, last_error_code FROM outbox WHERE id = ?")
      .bind(failed.id)
      .first<any>();
    expect(row).toEqual({
      state: "manual_contact",
      terminal_at: failed.terminal_at,
      last_error_code: "telegram_forbidden",
    });
  });
});
