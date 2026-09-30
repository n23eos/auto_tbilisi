import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup";
import { insertGroup } from "./group-fixtures";

const db = () => (env as any).DB as D1Database;

describe("runCleanup", () => {
  it("удаляет старые processed_updates и истёкшие анкеты", async () => {
    await db().prepare("INSERT INTO processed_updates (update_id, seen_at) VALUES (1, datetime('now', '-8 days'))").run();
    await db().prepare("INSERT INTO processed_updates (update_id) VALUES (2)").run();
    await db().prepare(
      `INSERT INTO conversations (
         id, chat_id, step, submission_id, revision, created_at, updated_at, expires_at
       ) VALUES ('expired-conversation', 1, 'name', 'x', 1,
                 datetime('now', '-2 hours'), datetime('now', '-2 hours'), datetime('now', '-1 hour'))`,
    ).run();

    await runCleanup(db());

    const updates = await db().prepare("SELECT update_id FROM processed_updates").all();
    expect(updates.results.map((r: any) => r.update_id)).toEqual([2]);
    const convs = await db().prepare("SELECT count(*) AS n FROM conversations").first<{ n: number }>();
    expect(convs!.n).toBe(0);
  });

  it("маскирует телефоны заявок, закрытых 90+ дней назад", async () => {
    await db().prepare(
      `INSERT INTO leads (submission_id, name, phone, student_chat_id, status, updated_at)
       VALUES ('old', 'А', '+995599000009', 1, 'closed', datetime('now', '-91 days')),
              ('recent', 'Б', '+995599000010', 2, 'closed', datetime('now', '-10 days'))`,
    ).run();

    await runCleanup(db());

    const rows = (await db().prepare("SELECT submission_id, phone FROM leads WHERE submission_id IN ('old','recent')").all()).results as any[];
    const byId = Object.fromEntries(rows.map((r) => [r.submission_id, r.phone]));
    expect(byId.old).toBe("удалён");
    expect(byId.recent).toBe("+995599000010");
  });

  // Заявку могут просто бросить: спам-запись, ученик не отвечает, админ не
  // довёл до «Закрыта». Такая строка навсегда оставалась бы со свежим
  // телефоном, и обещание школы хранить номер 90 дней не выполнялось бы.
  it("затирает телефоны и у НЕзакрытых заявок старше 180 дней", async () => {
    await db().prepare(
      `INSERT INTO leads (submission_id, name, phone, student_chat_id, status, created_at, updated_at)
       VALUES ('abandoned', 'Г', '+995599000020', 20, 'new',
               datetime('now', '-200 days'), datetime('now', '-200 days')),
              ('stuck', 'Д', '+995599000021', 21, 'in_progress',
               datetime('now', '-200 days'), datetime('now', '-200 days')),
              ('fresh', 'Е', '+995599000022', 22, 'new',
               datetime('now', '-10 days'), datetime('now', '-10 days'))`,
    ).run();

    await runCleanup(db());

    const rows = (await db().prepare("SELECT submission_id, phone FROM leads WHERE submission_id IN ('abandoned','stuck','fresh')").all()).results as any[];
    const byId = Object.fromEntries(rows.map((r) => [r.submission_id, r.phone]));
    expect(byId.abandoned).toBe("удалён");
    expect(byId.stuck).toBe("удалён");
    expect(byId.fresh).toBe("+995599000022");
  });

  // Журнал только пишется и нигде не читается кодом — он нужен для разбора
  // спорных случаев «кто взял заявку и куда она делась». Дальше 180 дней
  // разбирать нечего: у самой заявки к этому сроку уже затёрт телефон.
  it("удаляет события журнала старше 180 дней, свежие оставляет", async () => {
    await db().prepare(
      `INSERT INTO leads (id, submission_id, name, phone, student_chat_id)
       VALUES (900, 'events', 'Ж', '+995599000030', 30)`,
    ).run();
    await db().prepare(
      `INSERT INTO lead_events (lead_id, event, actor_id, created_at)
       VALUES (900, 'created', NULL, datetime('now', '-200 days')),
              (900, 'taken', 1, datetime('now', '-181 days')),
              (900, 'closed', 1, datetime('now', '-10 days'))`,
    ).run();

    await runCleanup(db());

    const { results } = await db().prepare("SELECT event FROM lead_events WHERE lead_id = 900 ORDER BY id").all();
    expect(results.map((r: any) => r.event)).toEqual(["closed"]);
  });

  // Затирать один телефон недостаточно: имя, свободный текст вопроса и
  // student_chat_id вместе так же однозначно указывают на человека, а
  // chat_id ещё и позволяет ему написать. Обещание «храним 90 дней» не
  // выполняется, пока эта тройка лежит в базе вечно.
  it("затирает имя, вопрос и chat_id вместе с телефоном", async () => {
    await db().prepare(
      `INSERT INTO leads (submission_id, name, phone, question, student_chat_id, status, updated_at)
       VALUES ('pii', 'Мария Иванова', '+995599000040', 'Хочу категорию B', 4040, 'closed',
               datetime('now', '-91 days'))`,
    ).run();

    await runCleanup(db());

    const row = await db()
      .prepare("SELECT name, phone, question, student_chat_id FROM leads WHERE submission_id = 'pii'")
      .first<{ name: string; phone: string; question: string | null; student_chat_id: number }>();
    expect(row!.phone).toBe("удалён");
    expect(row!.name).toBe("удалён");
    expect(row!.question).toBeNull();
    expect(row!.student_chat_id).toBe(0);
  });

  it("свежую заявку не трогает", async () => {
    await db().prepare(
      `INSERT INTO leads (submission_id, name, phone, question, student_chat_id, status)
       VALUES ('pii-fresh', 'Пётр', '+995599000041', 'вопрос', 4141, 'new')`,
    ).run();

    await runCleanup(db());

    const row = await db()
      .prepare("SELECT name, student_chat_id FROM leads WHERE submission_id = 'pii-fresh'")
      .first<{ name: string; student_chat_id: number }>();
    expect(row!.name).toBe("Пётр");
    expect(row!.student_chat_id).toBe(4141);
  });

  it("повторный прогон ничего не ломает: телефон уже затёрт, updated_at не сдвигается", async () => {
    await db().prepare(
      `INSERT INTO leads (submission_id, name, phone, student_chat_id, status, updated_at)
       VALUES ('twice', 'Г', '+995599000012', 4, 'closed', datetime('now', '-91 days'))`,
    ).run();

    await runCleanup(db());
    const afterFirst = await db()
      .prepare("SELECT phone, updated_at FROM leads WHERE submission_id = 'twice'")
      .first<{ phone: string; updated_at: string }>();
    await runCleanup(db());
    const afterSecond = await db()
      .prepare("SELECT phone, updated_at FROM leads WHERE submission_id = 'twice'")
      .first<{ phone: string; updated_at: string }>();

    expect(afterFirst!.phone).toBe("удалён");
    expect(afterSecond).toEqual(afterFirst);
  });

  it("удаляет booking PII по ранней границе terminal+90 или created+180", async () => {
    const groupId = await insertGroup(db(), { id: "cleanup-group", sequence: 91, startDate: "2099-12-01" });
    await db().prepare(
      `INSERT INTO bookings (
         id, public_reference, group_id, name, phone, student_chat_id, source,
         status, revision, consent_version, consent_at, created_at, updated_at, terminal_at
       ) VALUES
       ('terminal-old', 'BK-CLEAN-1', ?, 'Имя 1', '+995599000101', 101, 'telegram',
        'declined', 1, 'v1', datetime('now', '-100 days'), datetime('now', '-100 days'), datetime('now', '-100 days'), datetime('now', '-91 days')),
       ('created-old', 'BK-CLEAN-2', ?, 'Имя 2', '+995599000102', 102, 'telegram',
        'pending', 1, 'v1', datetime('now', '-181 days'), datetime('now', '-181 days'), datetime('now', '-181 days'), NULL),
       ('fresh-booking', 'BK-CLEAN-3', ?, 'Имя 3', '+995599000103', 103, 'telegram',
        'pending', 1, 'v1', datetime('now', '-10 days'), datetime('now', '-10 days'), datetime('now', '-10 days'), NULL)`,
    ).bind(groupId, groupId, groupId).run();

    await runCleanup(db());

    const rows = await db().prepare(
      "SELECT id, name, phone, student_chat_id, pii_erased_at FROM bookings WHERE id LIKE '%old' OR id = 'fresh-booking' ORDER BY id",
    ).all<any>();
    const byId = Object.fromEntries(rows.results.map((row) => [row.id, row]));
    for (const id of ["terminal-old", "created-old"]) {
      expect(byId[id].name).toBeNull();
      expect(byId[id].phone).toBeNull();
      expect(byId[id].student_chat_id).toBeNull();
      expect(byId[id].pii_erased_at).toBeTruthy();
    }
    expect(byId["fresh-booking"].phone).toBe("+995599000103");
  });

  it("очищает inbox payload за 24 часа, marker за 7 дней и служебные TTL", async () => {
    await db().prepare(
      `INSERT INTO inbox (
         update_id, chat_id, payload, state, attempts, created_at, updated_at,
         payload_expires_at, expires_at
       ) VALUES
       (8801, 88, '{"update_id":8801}', 'failed', 1,
        datetime('now', '-25 hours'), datetime('now', '-25 hours'), datetime('now', '-1 hour'), datetime('now', '+5 days', '+23 hours')),
       (8802, NULL, NULL, 'done', 1,
        datetime('now', '-8 days'), datetime('now', '-8 days'), datetime('now', '-7 days'), datetime('now', '-1 day'))`,
    ).run();
    await db().prepare(
      `INSERT INTO command_results (
         operation_id, scope, payload_digest, result_code, result_json, created_at, expires_at
       ) VALUES ('cleanup-command-key', 'test', 'digest', 'ok', '{}', datetime('now', '-25 hours'), datetime('now', '-1 hour'))`,
    ).run();
    await db().prepare(
      `INSERT INTO audit_events (
         id, entity_type, entity_id, operation_id, actor_id, action, created_at
       ) VALUES ('old-audit', 'booking', 'b', 'op', 'staff', 'test', datetime('now', '-181 days'))`,
    ).run();

    await runCleanup(db());

    const marker = await db().prepare("SELECT chat_id, payload, state, last_error_code FROM inbox WHERE update_id = 8801").first<any>();
    expect(marker).toEqual({ chat_id: null, payload: null, state: "failed", last_error_code: "payload_expired" });
    expect(await db().prepare("SELECT 1 FROM inbox WHERE update_id = 8802").first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM command_results WHERE operation_id = 'cleanup-command-key'").first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM audit_events WHERE id = 'old-audit'").first()).toBeNull();
  });

  it("отменяет prompt истекшей сессии до удаления conversation", async () => {
    await db().prepare(
      `INSERT INTO conversations (
         id, chat_id, step, data, submission_id, revision, created_at, updated_at, expires_at
       ) VALUES ('cleanup-conversation', 9901, 'name', '{}', 'sub', 1,
                 datetime('now', '-25 hours'), datetime('now', '-25 hours'), datetime('now', '-1 hour'))`,
    ).run();
    await db().prepare(
      `INSERT INTO outbox (
         id, event_id, conversation_id, event_type, safe_template_id,
         conversation_revision, recipient_key, recipient_role, state,
         created_at, updated_at
       ) VALUES ('cleanup-prompt', 'cleanup-event', 'cleanup-conversation',
                 'conversation_prompt', 'ask_name', 1, 'cleanup-conversation',
                 'student', 'pending', datetime('now', '-25 hours'), datetime('now', '-25 hours'))`,
    ).run();

    await runCleanup(db());

    expect(await db().prepare("SELECT 1 FROM conversations WHERE id = 'cleanup-conversation'").first()).toBeNull();
    const prompt = await db().prepare("SELECT state, terminal_at, last_error_code FROM outbox WHERE id = 'cleanup-prompt'").first<any>();
    expect(prompt.state).toBe("superseded");
    expect(prompt.terminal_at).toBeTruthy();
    expect(prompt.last_error_code).toBe("conversation_expired");
  });

  it("не удаляет unresolved manual-contact по старому failed terminal_at", async () => {
    await db().prepare(
      `INSERT INTO outbox (
         id, event_id, event_type, safe_template_id, recipient_key, recipient_role,
         state, created_at, updated_at, terminal_at, resolved_at, resolved_by_actor, last_error_code
       ) VALUES
       ('manual-open', 'manual-open-event', 'booking_confirmed', 'student_booking_confirmed',
        'booking-open', 'student', 'manual_contact', datetime('now', '-40 days'),
        datetime('now', '-40 days'), datetime('now', '-40 days'), NULL, NULL, 'telegram_forbidden'),
       ('resolved-old', 'resolved-old-event', 'booking_confirmed', 'student_booking_confirmed',
        'booking-resolved', 'student', 'resolved', datetime('now', '-40 days'),
        datetime('now', '-40 days'), datetime('now', '-31 days'), datetime('now', '-31 days'), 'staff', 'contacted')`,
    ).run();

    await runCleanup(db());

    expect(await db().prepare("SELECT state FROM outbox WHERE id = 'manual-open'").first<any>())
      .toEqual({ state: "manual_contact" });
    expect(await db().prepare("SELECT 1 FROM outbox WHERE id = 'resolved-old'").first()).toBeNull();
  });
});
