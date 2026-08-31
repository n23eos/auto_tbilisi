import { TelegramClient } from "./telegram";
import { CONTACTS, menuAnswer, searchKb } from "./kb";
import { getFact, setFact } from "./facts";
import {
  startConversation, getConversation, updateConversation, deleteConversation, validatePhone,
  truncate, NAME_LIMIT, QUESTION_LIMIT,
  type Conversation,
} from "./conversation";
import {
  createLead, getLead, takeLead, markCalled, closeLead, releaseLead, renderLeadCard,
} from "./leads";
import { escapeHtml, escapeClamped } from "./escape";
import { formatTbilisi } from "./time";
import type { Env } from "./types";

export const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "💰 Цены", callback_data: "menu:ceny" }, { text: "📄 Документы", callback_data: "menu:dokumenty" }],
    [{ text: "🎓 Экзамены", callback_data: "menu:ekzameny" }, { text: "📅 Ближайшая группа", callback_data: "menu:gruppa" }],
    [{ text: "📝 Записаться", callback_data: "menu:zapis" }, { text: "📞 Контакты", callback_data: "menu:kontakty" }],
  ],
};

const FALLBACK =
  "Не нашёл точного ответа в базе школы — выдумывать не буду. " +
  "Можно записаться, и администратор ответит лично, или посмотрите контакты:";

const FALLBACK_MENU = {
  inline_keyboard: [
    [{ text: "📝 Записаться", callback_data: "menu:zapis" }, { text: "📞 Контакты", callback_data: "menu:kontakty" }],
  ],
};

// Единственный факт, который бот реально читает (кнопка «Ближайшая группа»).
// Ключи вне этого списка админ задать не может: опечатка вроде «дата_группа»
// создала бы факт, который никто никогда не прочитает, а ученик продолжал бы
// видеть старую дату — и никто бы об этом не узнал.
const FACT_ALIASES: Record<string, string> = {
  дата_группы: "next_group_date",
};

// Потолок на имя и на имя админа в строке списка /zayavki: 10 заявок × 2 поля
// × 150 с запасом влезают в одно сообщение Telegram.
const LIST_FIELD_LIMIT = 150;

function makeClient(env: Env): TelegramClient {
  // __fetch — шов для тестов: они вызывают routeUpdate напрямую и подменяют fetch.
  // В проде поля нет, берётся глобальный fetch.
  return new TelegramClient(env.BOT_TOKEN, (env as any).__fetch ?? fetch);
}

/** Оба условия обязательны: сообщение из закрытой группы И отправитель в белом списке. */
function isAdmin(env: Env, chatId: number, userId: number): boolean {
  const admins = env.ADMIN_IDS.split(",").map((s) => Number(s.trim())).filter(Boolean);
  return chatId === Number(env.ADMIN_CHAT_ID) && admins.includes(userId);
}

export async function routeUpdate(update: any, env: Env): Promise<void> {
  const tg = makeClient(env);
  if (update.callback_query) return handleCallback(update.callback_query, env, tg);
  if (update.message) return handleMessage(update.message, env, tg);
}

async function handleMessage(msg: any, env: Env, tg: TelegramClient): Promise<void> {
  const chatId: number = msg.chat.id;
  const fromId: number = msg.from?.id ?? 0;
  const text: string = msg.text ?? "";

  if (chatId === Number(env.ADMIN_CHAT_ID)) {
    if (!isAdmin(env, chatId, fromId)) return;
    return handleAdminCommand(text, fromId, env, tg);
  }
  if (msg.chat.type !== "private") return;

  if (text === "/start") {
    await deleteConversation(env.DB, chatId);
    await tg.sendMessage(chatId, "Привет! Я бот автошколы. Отвечу на вопросы и запишу на занятия 👇", MAIN_MENU);
    return;
  }

  const conv = await getConversation(env.DB, chatId);
  if (conv) return handleFormInput(conv, msg, env, tg);

  const hit = text ? searchKb(text) : null;
  if (hit) {
    await tg.sendLong(chatId, hit.text, MAIN_MENU);
  } else {
    await tg.sendMessage(chatId, FALLBACK, FALLBACK_MENU);
  }
}

async function handleFormInput(conv: Conversation, msg: any, env: Env, tg: TelegramClient): Promise<void> {
  const chatId: number = msg.chat.id;
  const text: string = (msg.text ?? "").trim();

  if (conv.step === "name") {
    if (!text) { await tg.sendMessage(chatId, "Напишите, пожалуйста, ваше имя текстом."); return; }
    const name = truncate(text, NAME_LIMIT);
    await updateConversation(env.DB, chatId, "phone", { ...conv.data, name });
    if (name !== text) {
      await tg.sendMessage(chatId, `Имя длинновато — сократил до ${NAME_LIMIT} символов. Если что, администратор уточнит.`);
    }
    await tg.sendMessage(chatId, "Ваш телефон? Можно нажать кнопку ниже или ввести вручную.", {
      keyboard: [[{ text: "📱 Поделиться контактом", request_contact: true }]],
      resize_keyboard: true, one_time_keyboard: true,
    });
    return;
  }

  if (conv.step === "phone") {
    // Кнопка «Поделиться контактом» присылает contact с user_id самого
    // отправителя. Но через меню «прикрепить» можно переслать карточку ЛЮБОГО
    // человека — там user_id чужой или отсутствует. Принять такой номер значит
    // записать в заявку телефон постороннего, который ни на что не соглашался,
    // и школа позвонит ему. Ровно от этого защищает шаг с согласием.
    if (msg.contact && msg.contact.user_id !== msg.from?.id) {
      await tg.sendMessage(
        chatId,
        "Это контакт другого человека — записать могу только свой номер. " +
        "Нажмите кнопку ниже или введите номер вручную.",
        {
          keyboard: [[{ text: "📱 Поделиться контактом", request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true,
        },
      );
      return;
    }
    const raw = msg.contact?.phone_number ?? text;
    const phone = validatePhone(raw ?? "");
    if (!phone) {
      await tg.sendMessage(chatId, "Не похоже на телефон 🤔 Введите номер цифрами, например: +995 599 12 34 56");
      return;
    }
    await updateConversation(env.DB, chatId, "question", { ...conv.data, phone });
    await tg.sendMessage(chatId, "Что вас интересует? (категория, теория или практика, удобное время — свободным текстом)", { remove_keyboard: true });
    return;
  }

  if (conv.step === "question") {
    const question = truncate(text, QUESTION_LIMIT);
    await updateConversation(env.DB, chatId, "consent", { ...conv.data, question: question || "—" });
    if (question !== text) {
      await tg.sendMessage(chatId, `Вопрос длинный — сократил до ${QUESTION_LIMIT} символов. Подробности расскажете администратору голосом.`);
    }
    await tg.sendMessage(
      chatId,
      "Почти готово! Нажимая «Согласен», вы разрешаете школе использовать ваш номер, чтобы связаться с вами по вопросу записи.",
      { inline_keyboard: [[{ text: "✅ Согласен", callback_data: "form:consent_yes" }, { text: "❌ Отмена", callback_data: "form:consent_no" }]] },
    );
    return;
  }

  await tg.sendMessage(chatId, "Нажмите «Согласен», чтобы отправить заявку, или «Отмена».");
}

async function submitForm(chatId: number, env: Env, tg: TelegramClient): Promise<void> {
  const conv = await getConversation(env.DB, chatId);
  if (!conv || conv.step !== "consent" || !conv.data.name || !conv.data.phone) {
    await tg.sendMessage(chatId, "Анкета устарела. Начнём заново? Нажмите «Записаться» в меню.", MAIN_MENU);
    return;
  }
  const { leadId } = await createLead(env.DB, {
    submissionId: conv.submissionId,
    name: conv.data.name,
    phone: conv.data.phone,
    question: conv.data.question ?? null,
    studentChatId: chatId,
  });
  await deleteConversation(env.DB, chatId);
  await deliverCard(leadId, env, tg);
  await tg.sendMessage(chatId, "Заявка отправлена! Администратор свяжется с вами в рабочее время (10:00–20:00). Спасибо! 🚗", MAIN_MENU);
}

/**
 * Отправка карточки в админ-группу; при ошибке заявка остаётся pending — добьёт /resend.
 * Ученик в любом случае получает подтверждение: его данные уже сохранены, и молчать
 * в ответ хуже, чем не доставить карточку.
 */
async function deliverCard(leadId: number, env: Env, tg: TelegramClient): Promise<boolean> {
  const lead = await getLead(env.DB, leadId);
  if (!lead) return false;
  try {
    const card = renderLeadCard(lead);
    const sent = await tg.sendMessage(Number(env.ADMIN_CHAT_ID), card.text, card.keyboard);
    await env.DB
      .prepare("UPDATE leads SET delivery_status = 'delivered', telegram_message_id = ? WHERE id = ?")
      .bind(sent.message_id, leadId)
      .run();
    return true;
  } catch (err) {
    console.error(`Карточка заявки #${leadId} не доставлена:`, err);
    return false;
  }
}

async function handleCallback(cb: any, env: Env, tg: TelegramClient): Promise<void> {
  const chatId: number = cb.message?.chat?.id;
  const data: string = cb.data ?? "";

  if (data.startsWith("lead:")) return handleLeadCallback(cb, env, tg);

  // Всё остальное — только личка. Кнопки меню в группе игнорируются.
  if (cb.message?.chat?.type !== "private") { await tg.answerCallbackQuery(cb.id); return; }

  if (data === "menu:zapis") {
    await startConversation(env.DB, chatId);
    await tg.answerCallbackQuery(cb.id);
    await tg.sendMessage(chatId, "Запишу вас! Как вас зовут?");
    return;
  }
  if (data === "form:consent_yes") { await tg.answerCallbackQuery(cb.id); await submitForm(chatId, env, tg); return; }
  if (data === "form:consent_no") {
    await deleteConversation(env.DB, chatId);
    await tg.answerCallbackQuery(cb.id);
    await tg.sendMessage(chatId, "Заявка отменена. Если что — меню всегда тут 👇", MAIN_MENU);
    return;
  }
  if (data === "menu:kontakty") { await tg.answerCallbackQuery(cb.id); await tg.sendMessage(chatId, CONTACTS, MAIN_MENU); return; }
  if (data === "menu:gruppa") {
    const date = await getFact(env.DB, "next_group_date");
    await tg.answerCallbackQuery(cb.id);
    await tg.sendMessage(
      chatId,
      date
        ? `📅 Ближайшая группа по теории стартует: <b>${escapeHtml(date)}</b>\nЗаписаться можно прямо здесь 👇`
        : "Дату ближайшей группы уточняем — оставьте заявку, и администратор сообщит вам лично.",
      MAIN_MENU,
    );
    return;
  }
  if (data.startsWith("menu:")) {
    const id = data.slice("menu:".length);
    await tg.answerCallbackQuery(cb.id);
    // menuAnswer бросает на неизвестном id (старая кнопка, подделанный payload) —
    // это не повод ронять обработку апдейта: отвечаем честной заглушкой.
    let answer: string;
    try {
      answer = menuAnswer(id);
    } catch (err) {
      console.error(`Неизвестный пункт меню ${id}:`, err);
      await tg.sendMessage(chatId, FALLBACK, FALLBACK_MENU);
      return;
    }
    await tg.sendLong(chatId, answer, MAIN_MENU);
    return;
  }
  await tg.answerCallbackQuery(cb.id);
}

async function handleLeadCallback(cb: any, env: Env, tg: TelegramClient): Promise<void> {
  const chatId: number = cb.message?.chat?.id;
  const fromId: number = cb.from?.id ?? 0;
  if (!isAdmin(env, chatId, fromId)) {
    await tg.answerCallbackQuery(cb.id, "Только для администраторов");
    return;
  }
  const [, action, idStr] = cb.data.split(":");
  const leadId = Number(idStr);
  const adminName: string = cb.from.first_name ?? "админ";

  let ok = false;
  if (action === "take") ok = await takeLead(env.DB, leadId, fromId, adminName);
  else if (action === "called") ok = await markCalled(env.DB, leadId, fromId);
  else if (action === "close") ok = await closeLead(env.DB, leadId, fromId);
  else if (action === "release") ok = await releaseLead(env.DB, leadId, fromId);

  const lead = await getLead(env.DB, leadId);
  if (!ok) {
    const who = lead?.assigned_to_name ? `Заявку ведёт ${lead.assigned_to_name}` : "Действие уже выполнено";
    await tg.answerCallbackQuery(cb.id, who);
    return;
  }
  await tg.answerCallbackQuery(cb.id, "Готово");
  if (lead && cb.message?.message_id) {
    const card = renderLeadCard(lead);
    await tg.editMessageText(chatId, cb.message.message_id, card.text, card.keyboard);
  }
}

/**
 * В группах клиенты Telegram дописывают к команде имя бота: «/set@avtoshkola_bot дата_группы 15 сентября».
 * Срезаем «@имя» с первого токена, чтобы команды работали одинаково с упоминанием и без него.
 */
function stripBotMention(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return trimmed;
  const spaceIdx = trimmed.search(/\s/);
  const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const atIdx = command.indexOf("@");
  if (atIdx === -1) return trimmed;
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
  return command.slice(0, atIdx) + rest;
}

async function handleAdminCommand(raw: string, fromId: number, env: Env, tg: TelegramClient): Promise<void> {
  const adminChat = Number(env.ADMIN_CHAT_ID);
  const text = stripBotMention(raw);

  if (text.startsWith("/set ")) {
    const rest = text.slice("/set ".length).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx < 1) {
      await tg.sendMessage(adminChat, "Формат: /set дата_группы 15 сентября");
      return;
    }
    const alias = rest.slice(0, spaceIdx);
    const key = FACT_ALIASES[alias];
    if (!key) {
      await tg.sendMessage(
        adminChat,
        `Не знаю факт «${escapeHtml(alias)}». Сейчас можно менять только: ${Object.keys(FACT_ALIASES).join(", ")}.\nПример: /set дата_группы 15 сентября`,
      );
      return;
    }
    const value = rest.slice(spaceIdx + 1).trim();
    const { oldValue, newValue } = await setFact(env.DB, key, value, String(fromId));
    await tg.sendMessage(
      adminChat,
      `${escapeHtml(alias)}: «${escapeHtml(oldValue ?? "не было")}» → «${escapeHtml(newValue)}»`,
    );
    return;
  }

  if (text.startsWith("/zayavki")) {
    const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 10").all();
    if (results.length === 0) { await tg.sendMessage(adminChat, "Заявок пока нет."); return; }
    // Десять заявок склеиваются в ОДНО сообщение, поэтому длину режем в каждой
    // строке: одно длинное имя в базе иначе роняет всю команду, и она остаётся
    // сломанной, пока заявка не вывалится из последней десятки.
    const lines = (results as any[]).map((l) => {
      const undelivered = l.delivery_status === "pending" ? " ⚠️ карточка не доставлена" : "";
      const who = l.assigned_to_name ? ` · ведёт ${escapeClamped(l.assigned_to_name, LIST_FIELD_LIMIT)}` : "";
      return `#${l.id} ${escapeClamped(l.name, LIST_FIELD_LIMIT)} · ${l.status}${who} · ${formatTbilisi(l.created_at)}${undelivered}`;
    });
    await tg.sendMessage(adminChat, "<b>Последние заявки</b>\n" + lines.join("\n"));
    return;
  }

  if (text.startsWith("/resend")) {
    const { results } = await env.DB.prepare("SELECT id FROM leads WHERE delivery_status = 'pending' ORDER BY id").all();
    let delivered = 0;
    for (const row of results as any[]) {
      if (await deliverCard(row.id, env, tg)) delivered++;
    }
    await tg.sendMessage(adminChat, `Переотправлено карточек: ${delivered} из ${results.length}`);
    return;
  }
}
