import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup";

const db = () => (env as any).DB as D1Database;

describe("runCleanup", () => {
  it("удаляет старые processed_updates и истёкшие анкеты", async () => {
    await db().prepare("INSERT INTO processed_updates (update_id, seen_at) VALUES (1, datetime('now', '-8 days'))").run();
    await db().prepare("INSERT INTO processed_updates (update_id) VALUES (2)").run();
    await db().prepare("INSERT INTO conversations (chat_id, step, submission_id, expires_at) VALUES (1, 'name', 'x', datetime('now', '-1 hour'))").run();

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
});
