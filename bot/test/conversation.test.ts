import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  startConversation,
  getConversation,
  updateConversation,
  deleteConversation,
  startDurableConversation,
  advanceDurableConversation,
  validatePhone,
} from "../src/conversation";

const db = (env as any).DB as D1Database;

describe("conversation", () => {
  it("start создаёт состояние с шагом name и submission_id", async () => {
    await startConversation(db, 100);
    const c = await getConversation(db, 100);
    expect(c).not.toBeNull();
    expect(c!.step).toBe("name");
    expect(c!.submissionId).toMatch(/[0-9a-f-]{36}/);
    expect(c!.data).toEqual({});
  });

  it("повторный start заменяет старое состояние", async () => {
    await startConversation(db, 101);
    const firstConversation = (await getConversation(db, 101))!;
    await startConversation(db, 101);
    const secondConversation = (await getConversation(db, 101))!;
    expect(secondConversation.submissionId).not.toBe(firstConversation.submissionId);
    expect(secondConversation.id).toBe(firstConversation.id);
    expect(secondConversation.revision).toBe(firstConversation.revision + 1);
  });

  it("update двигает шаг и копит данные", async () => {
    await startConversation(db, 102);
    await updateConversation(db, 102, "phone", { name: "Вася" });
    const c = await getConversation(db, 102);
    expect(c!.step).toBe("phone");
    expect(c!.data).toEqual({ name: "Вася" });
  });

  it("истёкшее состояние не возвращается", async () => {
    await startConversation(db, 103);
    await db.prepare("UPDATE conversations SET expires_at = datetime('now', '-1 minute') WHERE chat_id = 103").run();
    expect(await getConversation(db, 103)).toBeNull();
    await startConversation(db, 103);
    expect(await getConversation(db, 103)).toMatchObject({ step: "name", data: {} });
  });

  it("delete удаляет", async () => {
    await startConversation(db, 104);
    await deleteConversation(db, 104);
    expect(await getConversation(db, 104)).toBeNull();
  });

  it("durable шаг и prompt коммитятся вместе, replay не двигает revision второй раз", async () => {
    const chatId = 105;
    await db.prepare(
      `INSERT INTO chat_leases (chat_id, lease_until, lease_token, revision, updated_at)
       VALUES (?, datetime('now', '+1 hour'), 'lease-105', 1, datetime('now'))`,
    ).bind(chatId).run();
    const input = {
      operationId: "telegram-update:10501",
      secret: "x".repeat(64),
      fence: { chatId, leaseToken: "lease-105", leaseRevision: 1 },
    };
    const first = await startDurableConversation(db, chatId, { bookingFlow: true }, "select_group", input);
    const replay = await startDurableConversation(db, chatId, { bookingFlow: true }, "select_group", input);
    expect(replay.revision).toBe(first.revision);
    const initialPrompts = await db.prepare(
      "SELECT count(*) AS n FROM outbox WHERE conversation_id = ?",
    ).bind(first.id).first<{ n: number }>();
    expect(initialPrompts?.n).toBe(1);

    await advanceDurableConversation(
      db,
      first,
      "phone",
      { ...first.data, name: "Анна" },
      "ask_phone",
      { ...input, operationId: "telegram-update:10502" },
    );
    const current = await getConversation(db, chatId);
    expect(current).toMatchObject({ step: "phone", revision: first.revision + 1, data: { name: "Анна" } });
    const prompts = await db.prepare(
      "SELECT state, conversation_revision FROM outbox WHERE conversation_id = ? ORDER BY conversation_revision",
    ).bind(first.id).all<any>();
    expect(prompts.results).toEqual([
      { state: "superseded", conversation_revision: first.revision },
      { state: "pending", conversation_revision: first.revision + 1 },
    ]);
  });

  it("stale lease не меняет шаг анкеты", async () => {
    const chatId = 106;
    await startConversation(db, chatId);
    const conversation = (await getConversation(db, chatId))!;
    await db.prepare(
      `INSERT INTO chat_leases (chat_id, lease_until, lease_token, revision, updated_at)
       VALUES (?, datetime('now', '+1 hour'), 'current-token', 2, datetime('now'))`,
    ).bind(chatId).run();

    await expect(advanceDurableConversation(
      db,
      conversation,
      "phone",
      { name: "Не должна сохраниться" },
      "ask_phone",
      {
        operationId: "telegram-update:10601",
        secret: "x".repeat(64),
        fence: { chatId, leaseToken: "stale-token", leaseRevision: 1 },
      },
    )).rejects.toThrow();
    expect(await getConversation(db, chatId)).toEqual(conversation);
  });
});

describe("validatePhone", () => {
  it("нормализует грузинский номер с пробелами", () => {
    expect(validatePhone("+995 599 98 77 07")).toBe("+995599987707");
  });
  it("принимает местный формат без кода", () => {
    expect(validatePhone("599 98 77 07")).toBe("599987707");
  });
  it("отклоняет мусор и слишком короткое", () => {
    expect(validatePhone("привет")).toBeNull();
    expect(validatePhone("12345")).toBeNull();
  });
});
