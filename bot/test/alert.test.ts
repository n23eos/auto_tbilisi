import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertAdmins, resetAlertThrottle } from "../src/alert";

const ADMIN_CHAT = -100500;

function makeEnv(sent: any[], chatId: string = String(ADMIN_CHAT)) {
  return {
    BOT_TOKEN: "TOKEN",
    ADMIN_CHAT_ID: chatId,
    __fetch: async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
  } as any;
}

beforeEach(() => {
  resetAlertThrottle();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("alertAdmins", () => {
  it("шлёт сообщение в чат админов с текстом ошибки", async () => {
    const sent: any[] = [];
    await alertAdmins(makeEnv(sent), "routeUpdate упал (update_id=7)", new Error("D1 недоступна"));

    expect(sent.length).toBe(1);
    expect(sent[0].body.chat_id).toBe(ADMIN_CHAT);
    expect(sent[0].body.text).toContain("update_id=7");
    expect(sent[0].body.text).toContain("D1 недоступна");
  });

  // Систематическая поломка даёт ошибку на каждом апдейте. Без паузы группа
  // админов утонула бы в одинаковых сообщениях, и настоящие заявки в ней
  // потерялись бы.
  it("не повторяет оповещение чаще раза в пять минут", async () => {
    const sent: any[] = [];
    const env = makeEnv(sent);

    await alertAdmins(env, "первый", new Error("бум"));
    await alertAdmins(env, "второй", new Error("бум"));
    vi.advanceTimersByTime(4 * 60 * 1000);
    await alertAdmins(env, "третий", new Error("бум"));

    expect(sent.length).toBe(1);
    expect(sent[0].body.text).toContain("первый");
  });

  it("после паузы оповещает снова", async () => {
    const sent: any[] = [];
    const env = makeEnv(sent);

    await alertAdmins(env, "первый", new Error("бум"));
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await alertAdmins(env, "второй", new Error("бум"));

    expect(sent.map((s) => s.body.text.includes("второй"))).toContain(true);
    expect(sent.length).toBe(2);
  });

  it("молчит, если чат админов не задан", async () => {
    const sent: any[] = [];
    await alertAdmins(makeEnv(sent, ""), "контекст", new Error("бум"));
    await alertAdmins(makeEnv(sent, "0"), "контекст", new Error("бум"));
    expect(sent.length).toBe(0);
  });

  // Telegram недоступен ровно тогда, когда чаще всего падает и сам бот.
  // Исключение отсюда подменило бы собой исходную ошибку в логе.
  it("не бросает, если Telegram недоступен", async () => {
    const env = {
      BOT_TOKEN: "TOKEN",
      ADMIN_CHAT_ID: String(ADMIN_CHAT),
      __fetch: async () => {
        throw new Error("сеть недоступна");
      },
    } as any;
    await expect(alertAdmins(env, "контекст", new Error("бум"))).resolves.toBeUndefined();
  });

  it("экранирует HTML в тексте ошибки", async () => {
    const sent: any[] = [];
    await alertAdmins(makeEnv(sent), "контекст", new Error("<b>сломалось</b>"));
    expect(sent[0].body.text).toContain("&lt;b&gt;сломалось&lt;/b&gt;");
    expect(sent[0].body.text).not.toContain("<b>сломалось</b>");
  });
});
