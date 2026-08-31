import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  startConversation,
  getConversation,
  updateConversation,
  deleteConversation,
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
    const first = (await getConversation(db, 101))!.submissionId;
    await startConversation(db, 101);
    const second = (await getConversation(db, 101))!.submissionId;
    expect(second).not.toBe(first);
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
  });

  it("delete удаляет", async () => {
    await startConversation(db, 104);
    await deleteConversation(db, 104);
    expect(await getConversation(db, 104)).toBeNull();
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
