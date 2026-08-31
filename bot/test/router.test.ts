import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { routeUpdate } from "../src/router";
import { getConversation } from "../src/conversation";
import { getFact } from "../src/facts";
import type { Env } from "../src/types";

const ADMIN_CHAT = -100500;
const ADMIN_ID = 777;

// Настоящий лимит Telegram на текст сообщения.
const TELEGRAM_TEXT_LIMIT = 4096;

function makeEnv(sent: any[]): Env {
  const fetchFn = vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), body });
    // Telegram отвечает 400, а не молча режет текст. Без этого фейк принимал
    // любую длину, и тесты не замечали бы недоставленных карточек.
    if (typeof body.text === "string" && body.text.length > TELEGRAM_TEXT_LIMIT) {
      return new Response(
        JSON.stringify({ ok: false, description: "Bad Request: message is too long" }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    DB: (env as any).DB,
    BOT_TOKEN: "T",
    WEBHOOK_SECRET: "S",
    ADMIN_CHAT_ID: String(ADMIN_CHAT),
    ADMIN_IDS: String(ADMIN_ID),
    __fetch: fetchFn,
  } as any;
}

function privateMessage(chatId: number, text: string, extra: object = {}) {
  return { update_id: Math.floor(Math.random() * 1e9), message: { chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Вася" }, text, ...extra } };
}

describe("router: ученик", () => {
  it("/start отвечает приветствием с меню", async () => {
    const sent: any[] = [];
    await routeUpdate(privateMessage(1, "/start"), makeEnv(sent));
    expect(sent[0].body.reply_markup.inline_keyboard.flat().length).toBe(6);
  });

  it("кнопка «Записаться» стартует анкету", async () => {
    const sent: any[] = [];
    await routeUpdate(
      { update_id: 1, callback_query: { id: "cb1", from: { id: 2, first_name: "Вася" }, message: { chat: { id: 2, type: "private" } }, data: "menu:zapis" } },
      makeEnv(sent),
    );
    const c = await getConversation((env as any).DB, 2);
    expect(c!.step).toBe("name");
  });

  it("полный проход анкеты создаёт заявку и шлёт карточку в админ-группу", async () => {
    const sent: any[] = [];
    const e = makeEnv(sent);
    await routeUpdate({ update_id: 2, callback_query: { id: "cb2", from: { id: 3, first_name: "Вася" }, message: { chat: { id: 3, type: "private" } }, data: "menu:zapis" } }, e);
    await routeUpdate(privateMessage(3, "Вася Пупкин"), e);
    await routeUpdate(privateMessage(3, "+995 599 11 22 33"), e);
    await routeUpdate(privateMessage(3, "Категория B, теория"), e);
    await routeUpdate({ update_id: 3, callback_query: { id: "cb3", from: { id: 3, first_name: "Вася" }, message: { chat: { id: 3, type: "private" } }, data: "form:consent_yes" } }, e);

    const lead = await (env as any).DB.prepare("SELECT * FROM leads WHERE student_chat_id = 3").first();
    expect(lead.name).toBe("Вася Пупкин");
    expect(lead.phone).toBe("+995599112233");
    expect(lead.delivery_status).toBe("delivered");
    const cardMsg = sent.find((s) => s.body.chat_id === ADMIN_CHAT);
    expect(cardMsg.body.text).toContain("Вася Пупкин");
  });

  it("без согласия заявка не создаётся", async () => {
    const sent: any[] = [];
    const e = makeEnv(sent);
    await routeUpdate({ update_id: 4, callback_query: { id: "cb4", from: { id: 4, first_name: "П" }, message: { chat: { id: 4, type: "private" } }, data: "menu:zapis" } }, e);
    await routeUpdate(privateMessage(4, "Петя"), e);
    await routeUpdate(privateMessage(4, "599112234"), e);
    await routeUpdate(privateMessage(4, "вопрос"), e);
    await routeUpdate({ update_id: 5, callback_query: { id: "cb5", from: { id: 4, first_name: "П" }, message: { chat: { id: 4, type: "private" } }, data: "form:consent_no" } }, e);
    const lead = await (env as any).DB.prepare("SELECT * FROM leads WHERE student_chat_id = 4").first();
    expect(lead).toBeNull();
  });

  it("вопрос на 5000 символов: карточка влезает в лимит и доставляется", async () => {
    const sent: any[] = [];
    const e = makeEnv(sent);
    await routeUpdate({ update_id: 20, callback_query: { id: "c20", from: { id: 20, first_name: "Д" }, message: { chat: { id: 20, type: "private" } }, data: "menu:zapis" } }, e);
    await routeUpdate(privateMessage(20, "Длинный"), e);
    await routeUpdate(privateMessage(20, "+995599112240"), e);
    await routeUpdate(privateMessage(20, "я".repeat(5000)), e);
    await routeUpdate({ update_id: 21, callback_query: { id: "c21", from: { id: 20, first_name: "Д" }, message: { chat: { id: 20, type: "private" } }, data: "form:consent_yes" } }, e);

    const lead = await (env as any).DB.prepare("SELECT * FROM leads WHERE student_chat_id = 20").first();
    expect(lead.delivery_status).toBe("delivered");
    const card = sent.find((s) => s.body.chat_id === ADMIN_CHAT);
    expect(card.body.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("имя из «<» не раздувает карточку экранированием сверх лимита", async () => {
    const sent: any[] = [];
    const e = makeEnv(sent);
    await routeUpdate({ update_id: 22, callback_query: { id: "c22", from: { id: 22, first_name: "Д" }, message: { chat: { id: 22, type: "private" } }, data: "menu:zapis" } }, e);
    await routeUpdate(privateMessage(22, "<".repeat(1100)), e);
    await routeUpdate(privateMessage(22, "+995599112242"), e);
    await routeUpdate(privateMessage(22, "вопрос"), e);
    await routeUpdate({ update_id: 23, callback_query: { id: "c23", from: { id: 22, first_name: "Д" }, message: { chat: { id: 22, type: "private" } }, data: "form:consent_yes" } }, e);

    const lead = await (env as any).DB.prepare("SELECT * FROM leads WHERE student_chat_id = 22").first();
    expect(lead.delivery_status).toBe("delivered");
    const card = sent.find((s) => s.body.chat_id === ADMIN_CHAT);
    expect(card.body.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("ученику говорят, что текст сокращён, а не режут молча", async () => {
    const sent: any[] = [];
    const e = makeEnv(sent);
    await routeUpdate({ update_id: 24, callback_query: { id: "c24", from: { id: 24, first_name: "Д" }, message: { chat: { id: 24, type: "private" } }, data: "menu:zapis" } }, e);
    sent.length = 0;
    await routeUpdate(privateMessage(24, "И".repeat(500)), e);
    expect(sent.map((s) => s.body.text).join(" ")).toContain("сократил");
  });

  it("невалидный телефон переспрашивает и не двигает шаг", async () => {
    const sent: any[] = [];
    const e = makeEnv(sent);
    await routeUpdate({ update_id: 6, callback_query: { id: "cb6", from: { id: 5, first_name: "П" }, message: { chat: { id: 5, type: "private" } }, data: "menu:zapis" } }, e);
    await routeUpdate(privateMessage(5, "Петя"), e);
    await routeUpdate(privateMessage(5, "не скажу"), e);
    expect((await getConversation((env as any).DB, 5))!.step).toBe("phone");
  });
});

describe("router: админы", () => {
  it("/set работает в админ-группе и показывает старое→новое", async () => {
    const sent: any[] = [];
    await routeUpdate(
      { update_id: 7, message: { chat: { id: ADMIN_CHAT, type: "supergroup" }, from: { id: ADMIN_ID, first_name: "Нина" }, text: "/set дата_группы 15 сентября" } },
      makeEnv(sent),
    );
    expect(sent[0].body.text).toContain("15 сентября");
  });

  it("/set@botname работает так же, как голая команда", async () => {
    const sent: any[] = [];
    await routeUpdate(
      { update_id: 71, message: { chat: { id: ADMIN_CHAT, type: "supergroup" }, from: { id: ADMIN_ID, first_name: "Нина" }, text: "/set@some_bot дата_группы 15 сентября" } },
      makeEnv(sent),
    );
    expect(sent[0].body.text).toContain("15 сентября");
    expect(await getFact((env as any).DB, "next_group_date")).toBe("15 сентября");
  });

  it("/zayavki@botname тоже распознаётся", async () => {
    const sent: any[] = [];
    await routeUpdate(
      { update_id: 72, message: { chat: { id: ADMIN_CHAT, type: "supergroup" }, from: { id: ADMIN_ID, first_name: "Нина" }, text: "/zayavki@some_bot" } },
      makeEnv(sent),
    );
    expect(sent[0].body.text).toContain("Заяв");
  });

  it("/zayavki переживает имя на 2000 символов, уже лежащее в базе", async () => {
    await (env as any).DB.prepare(
      `INSERT INTO leads (submission_id, name, phone, student_chat_id)
       VALUES ('long-name', ?, '+995599112299', 99)`,
      // Именно «<»: escapeHtml раздувает его вчетверо («&lt;»), и 2000 символов
      // превращаются в 8000 — вдвое больше лимита Telegram.
    ).bind("<".repeat(2000)).run();

    const sent: any[] = [];
    await routeUpdate(
      { update_id: 73, message: { chat: { id: ADMIN_CHAT, type: "supergroup" }, from: { id: ADMIN_ID, first_name: "Нина" }, text: "/zayavki" } },
      makeEnv(sent),
    );
    expect(sent.length).toBe(1);
    expect(sent[0].body.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("/set от чужого игнорируется", async () => {
    const sent: any[] = [];
    await routeUpdate(
      { update_id: 8, message: { chat: { id: ADMIN_CHAT, type: "supergroup" }, from: { id: 999, first_name: "Чужой" }, text: "/set дата_группы 1 января" } },
      makeEnv(sent),
    );
    expect(sent.length).toBe(0);
  });

  it("админ-команда в личке не работает", async () => {
    const sent: any[] = [];
    await routeUpdate(privateMessage(ADMIN_ID, "/zayavki"), makeEnv(sent));
    expect(sent[0]?.body?.text ?? "").not.toContain("Заявк");
  });

  it("callback «Взять» от не-админа отклоняется", async () => {
    const sent: any[] = [];
    await routeUpdate(
      { update_id: 9, callback_query: { id: "cb9", from: { id: 999, first_name: "Чужой" }, message: { chat: { id: ADMIN_CHAT, type: "supergroup" }, message_id: 1 }, data: "lead:take:1" } },
      makeEnv(sent),
    );
    expect(sent.length).toBe(1);
    expect(sent[0].url).toContain("answerCallbackQuery");
  });
});
