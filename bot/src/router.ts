import { TelegramClient } from "./telegram";
import { CONTACTS, PHONE, menuAnswer, searchKb } from "./kb";
import { getFact, setFact } from "./facts";
import {
  startConversation, getConversation, updateConversation, deleteConversation, validatePhone,
  startDurableConversation, advanceDurableConversation,
  truncate, NAME_LIMIT, QUESTION_LIMIT,
  type Conversation,
} from "./conversation";
import { publicGroups } from "./groups";
import { createBooking, bookingAction } from "./bookings";
import { DomainError } from "./booking-commands";
import { supersedeConversationPrompts } from "./outbox";
import {
  createLead, getLead, takeLead, markCalled, closeLead, releaseLead, forceReleaseLead,
  renderLeadCard, statusLabel,
} from "./leads";
import { escapeClamped } from "./escape";
import { formatTbilisi } from "./time";
import type { Env } from "./types";

export interface RouteContext {
  operationId: string;
  fence: { chatId: number; leaseToken: string; leaseRevision: number };
}

const TELEGRAM_CONSENT_VERSION = "telegram-group-booking-v1-2026-09-29";

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

// Потолок на имя и значение факта в /set. Значение задаёт админ руками, и оно
// уходит в ДВА сообщения: подтверждение ему самому («старое → новое») и ответ
// ученику на кнопку «Ближайшая группа». Без потолка одна длинная команда ломает
// обе точки разом: экранирование раздувает «<» вчетверо, sendMessage отвечает
// 400 — админ не видит ни подтверждения, ни причины, а кнопка у учеников молча
// перестаёт отвечать. 200 символов на дату группы — с большим запасом.
const FACT_FIELD_LIMIT = 200;

/**
 * Сколько заявок один и тот же чат может подать за сутки.
 *
 * Анкету может пройти любой пользователь Telegram, и без потолка её несложно
 * прокрутить в цикле: каждая заявка — карточка в группу админов. За лимитом
 * Telegram (около 20 сообщений в минуту в группу) отправка начинает падать,
 * карточки копятся в pending, и настоящие заявки тонут среди спама.
 *
 * Три — с запасом для живого человека: заявка, потом «ой, не тот телефон»,
 * потом ещё одна на всякий случай. Четвёртая за сутки уже похожа на скрипт,
 * и такому отвечаем телефоном школы, а не молчанием.
 */
export const DAILY_LEAD_LIMIT = 3;

/**
 * Размер пачки /resend. Без потолка команда перебирала ВСЮ очередь pending
 * в одном запросе: на каждую заявку чтение из D1, вызов Telegram и запись.
 * При сотне накопившихся карточек это упирается в лимит подзапросов воркера,
 * и /resend начинает падать раз за разом — то есть ломается ровно тот
 * инструмент, которым эту очередь и разгребают.
 */
export const RESEND_BATCH = 25;

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

function normalizeBookingPhone(raw: string): string | null {
  const value = validatePhone(raw);
  if (!value) return null;
  if (value.startsWith("+")) return /^\+\d{7,15}$/.test(value) ? value : null;
  const international = value.length === 9 && value.startsWith("5") ? `+995${value}` : `+${value}`;
  return /^\+\d{7,15}$/.test(international) ? international : null;
}

function requireBookingContext(env: Env, context?: RouteContext): RouteContext {
  if (!context || !env.BOOKING_SECRET) throw new Error("durable_booking_context_missing");
  return context;
}

function errorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

async function answerCallbackBestEffort(
  tg: TelegramClient,
  callbackId: string,
  text?: string,
): Promise<void> {
  try {
    await tg.answerCallbackQuery(callbackId, text);
  } catch (error) {
    // Ответ на callback только закрывает индикатор Telegram. Сообщение анкеты
    // или доменная команда уже защищены outbox и не должны повторяться из-за него.
    console.error(`Telegram callback answer не доставлен (${errorClass(error)})`);
  }
}

export async function routeUpdate(update: any, env: Env, context?: RouteContext): Promise<void> {
  const tg = makeClient(env);
  if (update.callback_query) return handleCallback(update.callback_query, env, tg, context);
  if (update.message) return handleMessage(update.message, env, tg, context);
}

async function handleMessage(
  msg: any,
  env: Env,
  tg: TelegramClient,
  context?: RouteContext,
): Promise<void> {
  const chatId: number = msg.chat.id;
  const fromId: number = msg.from?.id ?? 0;
  const text: string = msg.text ?? "";

  if (chatId === Number(env.ADMIN_CHAT_ID)) {
    if (!isAdmin(env, chatId, fromId)) return;
    return handleAdminCommand(text, fromId, env, tg);
  }
  if (msg.chat.type !== "private") return;

  if (text === "/start") {
    await deleteConversation(env.DB, chatId, undefined, context?.fence);
    await tg.sendMessage(chatId, "Привет! Я бот автошколы. Отвечу на вопросы и запишу на занятия 👇", MAIN_MENU);
    return;
  }

  const conv = await getConversation(env.DB, chatId);
  if (conv) return handleFormInput(conv, msg, env, tg, context);

  const hit = text ? searchKb(text) : null;
  if (hit) {
    await tg.sendLong(chatId, hit.text, MAIN_MENU);
  } else {
    await tg.sendMessage(chatId, FALLBACK, FALLBACK_MENU);
  }
}

async function handleFormInput(
  conv: Conversation,
  msg: any,
  env: Env,
  tg: TelegramClient,
  context?: RouteContext,
): Promise<void> {
  const chatId: number = msg.chat.id;
  const text: string = (msg.text ?? "").trim();

  if (env.BOOKING_ENABLED === "true" && conv.data.bookingFlow) {
    if (!context || !env.BOOKING_SECRET) throw new Error("durable_booking_context_missing");
    if (conv.step === "name") {
      if (!text) {
        await tg.sendMessage(chatId, "Напишите, пожалуйста, ваше имя текстом.");
        return;
      }
      const name = truncate(text, NAME_LIMIT);
      await advanceDurableConversation(
        env.DB,
        conv,
        "phone",
        { ...conv.data, name },
        "ask_phone",
        { operationId: context.operationId, secret: env.BOOKING_SECRET, fence: context.fence },
      );
      return;
    }
    if (conv.step === "phone") {
      if (msg.contact && msg.contact.user_id !== msg.from?.id) {
        await tg.sendMessage(chatId, "Можно записать только свой номер. Введите его вручную или поделитесь своим контактом.");
        return;
      }
      const phone = normalizeBookingPhone(msg.contact?.phone_number ?? text);
      if (!phone) {
        await tg.sendMessage(chatId, "Введите телефон с кодом страны, например +995 599 12 34 56.");
        return;
      }
      await advanceDurableConversation(
        env.DB,
        conv,
        "consent",
        { ...conv.data, phone },
        "ask_consent",
        { operationId: context.operationId, secret: env.BOOKING_SECRET, fence: context.fence },
      );
      return;
    }
    await tg.sendMessage(chatId, "Нажмите Согласен, чтобы отправить запись, или Отмена.");
    return;
  }

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
  // Потолок заявок с одного чата за сутки. Считаем ДО createLead: иначе строка
  // уже вставлена, и «отказ» означал бы мусор в базе при каждой попытке.
  const recent = await env.DB
    .prepare("SELECT count(*) AS n FROM leads WHERE student_chat_id = ? AND created_at > datetime('now', '-1 day')")
    .bind(chatId)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= DAILY_LEAD_LIMIT) {
    await deleteConversation(env.DB, chatId);
    await tg.sendMessage(
      chatId,
      `Заявка от вас уже принята — администратор свяжется с вами. ` +
        `Если дело срочное, позвоните напрямую: ${PHONE}`,
      MAIN_MENU,
    );
    return;
  }

  const { created, leadId } = await createLead(env.DB, {
    submissionId: conv.submissionId,
    name: conv.data.name,
    phone: conv.data.phone,
    question: conv.data.question ?? null,
    studentChatId: chatId,
  });
  await deleteConversation(env.DB, chatId);
  // createLead идемпотентен по submission_id, но карточка и подтверждение —
  // нет. Два нажатия «Согласен» приходят разными update_id (дедуп вебхука их
  // не ловит) и обрабатываются параллельно: оба успевают прочитать анкету до
  // её удаления. Без этой проверки в группу уходят две карточки на одну заявку,
  // обе с живыми кнопками, и два подтверждения ученику.
  if (!created) {
    await tg.sendMessage(chatId, "Заявка уже отправлена — администратор свяжется с вами. 🚗", MAIN_MENU);
    return;
  }
  await deliverCard(leadId, env, tg);
  await tg.sendMessage(chatId, "Заявка отправлена! Администратор свяжется с вами в рабочее время (10:00–20:00). Спасибо! 🚗", MAIN_MENU);
}

/**
 * Отправка карточки в админ-группу; при ошибке заявка остаётся pending — добьёт /resend.
 * Ученик в любом случае получает подтверждение: его данные уже сохранены, и молчать
 * в ответ хуже, чем не доставить карточку.
 */
async function deliverCard(leadId: number, env: Env, tg: TelegramClient, notice?: string): Promise<boolean> {
  const lead = await getLead(env.DB, leadId);
  if (!lead) return false;
  try {
    const card = renderLeadCard(lead);
    const text = notice ? `${notice}\n${card.text}` : card.text;
    const sent = await tg.sendMessage(Number(env.ADMIN_CHAT_ID), text, card.keyboard);
    await env.DB
      .prepare("UPDATE leads SET delivery_status = 'delivered', telegram_message_id = ? WHERE id = ?")
      .bind(sent.message_id, leadId)
      .run();
    return true;
  } catch (err) {
    console.error(`Карточка заявки #${leadId} не доставлена (${errorClass(err)})`);
    return false;
  }
}

async function handleCallback(
  cb: any,
  env: Env,
  tg: TelegramClient,
  context?: RouteContext,
): Promise<void> {
  const chatId: number = cb.message?.chat?.id;
  const data: string = cb.data ?? "";

  if (data.startsWith("lead:")) return handleLeadCallback(cb, env, tg);
  if (data.startsWith("bk:")) return handleBookingAdminCallback(cb, env, tg, context);

  // Всё остальное — только личка. Кнопки меню в группе игнорируются.
  if (cb.message?.chat?.type !== "private") { await tg.answerCallbackQuery(cb.id); return; }

  if (data === "menu:zapis") {
    if (env.BOOKING_ENABLED === "true") {
      const durable = requireBookingContext(env, context);
      await startDurableConversation(
        env.DB,
        chatId,
        { bookingFlow: true },
        "select_group",
        { operationId: durable.operationId, secret: env.BOOKING_SECRET!, fence: durable.fence },
      );
      await answerCallbackBestEffort(tg, cb.id);
      return;
    }
    await startConversation(env.DB, chatId);
    await tg.answerCallbackQuery(cb.id);
    await tg.sendMessage(chatId, "Запишу вас! Как вас зовут?");
    return;
  }
  if (env.BOOKING_ENABLED === "true" && data.startsWith("bg:")) {
    const durable = requireBookingContext(env, context);
    const [, sequenceRaw, revisionRaw] = data.split(":");
    const sequence = Number(sequenceRaw);
    const revision = Number(revisionRaw);
    const group = Number.isSafeInteger(sequence) && Number.isSafeInteger(revision)
      ? await env.DB
          .prepare(
            `SELECT id, sequence, revision, start_date, start_time
             FROM groups
             WHERE service_id = 'theory_group' AND sequence = ? AND revision = ?
               AND lifecycle = 'scheduled' AND enrollment_open = 1
               AND datetime(starts_at_utc) > datetime('now')
               AND (SELECT count(*) FROM bookings b
                    WHERE b.group_id = groups.id AND b.status = 'confirmed') < capacity`,
          )
          .bind(sequence, revision)
          .first<{ id: string; sequence: number; revision: number; start_date: string; start_time: string }>()
      : null;
    if (!group) {
      await startDurableConversation(
        env.DB,
        chatId,
        { bookingFlow: true },
        "select_group",
        { operationId: durable.operationId, secret: env.BOOKING_SECRET!, fence: durable.fence },
      );
      await answerCallbackBestEffort(tg, cb.id, "Список обновился");
      return;
    }
    await startDurableConversation(
      env.DB,
      chatId,
      {
        bookingFlow: true,
        groupId: group.id,
        groupRevision: group.revision,
        groupSequence: group.sequence,
        groupLabel: `${group.start_date} ${group.start_time}`,
      },
      "ask_name",
      { operationId: durable.operationId, secret: env.BOOKING_SECRET!, fence: durable.fence },
    );
    await answerCallbackBestEffort(tg, cb.id);
    return;
  }
  if (env.BOOKING_ENABLED === "true" && data.startsWith("bf:")) {
    return handleBookingConsent(cb, env, tg, context);
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
    if (env.BOOKING_ENABLED === "true") {
      const snapshot = await publicGroups(env.DB);
      await tg.answerCallbackQuery(cb.id);
      if (snapshot.groups.length === 0) {
        await tg.sendMessage(chatId, "Сейчас нет открытых групп. Администратор подскажет следующий старт.", MAIN_MENU);
        return;
      }
      const { results: tokens } = await env.DB
        .prepare(
          `SELECT id, sequence FROM groups
           WHERE id IN (${snapshot.groups.map(() => "?").join(",")})`,
        )
        .bind(...snapshot.groups.map((group) => group.id))
        .all<{ id: string; sequence: number }>();
      const sequenceById = new Map(tokens.map((row) => [row.id, row.sequence]));
      const openGroups = snapshot.groups.filter((group) => group.availability === "open");
      await tg.sendMessage(
        chatId,
        snapshot.groups
          .map((group) => {
            const availability = group.availability === "full"
              ? "мест нет"
              : group.availability === "closed" ? "запись закрыта" : "запись открыта";
            const dateStatus = group.dateStatus === "planned" ? "предварительно" : "дата подтверждена";
            return `${group.startDate} ${group.startTime} (${dateStatus}, ${availability})`;
          })
          .join("\n"),
        openGroups.length > 0 ? {
          inline_keyboard: openGroups.map((group) => [{
            text: `Выбрать ${group.startDate}`,
            callback_data: `bg:${sequenceById.get(group.id)}:${group.revision}`,
          }]),
        } : MAIN_MENU,
      );
      return;
    }
    const date = await getFact(env.DB, "next_group_date");
    await tg.answerCallbackQuery(cb.id);
    await tg.sendMessage(
      chatId,
      date
        ? `📅 Ближайшая группа по теории стартует: <b>${escapeClamped(date, FACT_FIELD_LIMIT)}</b>\nЗаписаться можно прямо здесь 👇`
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
      console.error(`Неизвестный пункт меню ${id} (${errorClass(err)})`);
      await tg.sendMessage(chatId, FALLBACK, FALLBACK_MENU);
      return;
    }
    await tg.sendLong(chatId, answer, MAIN_MENU);
    return;
  }
  await answerCallbackBestEffort(tg, cb.id);
}

async function handleBookingConsent(
  cb: any,
  env: Env,
  tg: TelegramClient,
  context?: RouteContext,
): Promise<void> {
  const durable = requireBookingContext(env, context);
  const chatId = Number(cb.message?.chat?.id);
  const [, revisionRaw, answer] = String(cb.data).split(":");
  const expectedRevision = Number(revisionRaw);
  const conversation = await getConversation(env.DB, chatId);
  await tg.answerCallbackQuery(cb.id);
  if (
    !conversation
    || conversation.revision !== expectedRevision
    || conversation.step !== "consent"
    || !conversation.data.bookingFlow
  ) {
    await tg.sendMessage(chatId, "Эта кнопка устарела. Откройте запись заново из меню.", MAIN_MENU);
    return;
  }
  if (answer === "no") {
    await supersedeConversationPrompts(env.DB, conversation.id);
    await deleteConversation(env.DB, chatId, conversation.revision, durable.fence);
    await tg.sendMessage(chatId, "Запись отменена. Меню остается доступно ниже.", MAIN_MENU);
    return;
  }
  if (
    answer !== "yes"
    || !conversation.data.groupId
    || !conversation.data.groupRevision
    || !conversation.data.name
    || !conversation.data.phone
  ) {
    await tg.sendMessage(chatId, "Анкета неполная. Откройте запись заново из меню.", MAIN_MENU);
    return;
  }

  try {
    await createBooking(
      env.DB,
      {
        groupId: conversation.data.groupId,
        groupRevision: conversation.data.groupRevision,
        name: conversation.data.name,
        phone: conversation.data.phone,
        consentVersion: TELEGRAM_CONSENT_VERSION,
        source: "telegram",
        studentChatId: chatId,
        conversation: { id: conversation.id, revision: conversation.revision },
        fence: durable.fence,
      },
      durable.operationId,
      env.BOOKING_SECRET!,
    );
  } catch (error) {
    if (error instanceof DomainError && ["group_changed", "group_full", "group_closed"].includes(error.code)) {
      await startDurableConversation(
        env.DB,
        chatId,
        { bookingFlow: true },
        "select_group",
        { operationId: durable.operationId, secret: env.BOOKING_SECRET!, fence: durable.fence },
      );
      return;
    }
    throw error;
  }
}

async function handleBookingAdminCallback(
  cb: any,
  env: Env,
  tg: TelegramClient,
  context?: RouteContext,
): Promise<void> {
  const chatId = Number(cb.message?.chat?.id);
  const fromId = Number(cb.from?.id ?? 0);
  if (!isAdmin(env, chatId, fromId)) {
    await answerCallbackBestEffort(tg, cb.id, "Только для администраторов");
    return;
  }
  if (env.BOOKING_ENABLED !== "true") {
    await answerCallbackBestEffort(tg, cb.id, "Новая запись пока отключена");
    return;
  }
  const durable = requireBookingContext(env, context);
  const [, reference, revisionRaw, shortAction] = String(cb.data).split(":");
  const expectedRevision = Number(revisionRaw);
  const action = shortAction === "c" ? "confirm" : shortAction === "d" ? "decline" : null;
  if (!reference || !Number.isSafeInteger(expectedRevision) || !action) {
    await answerCallbackBestEffort(tg, cb.id, "Битая или устаревшая кнопка");
    return;
  }
  const booking = await env.DB
    .prepare(
      `SELECT b.id, b.revision, g.revision AS group_revision
       FROM bookings b JOIN groups g ON g.id = b.group_id
       WHERE b.public_reference = ?`,
    )
    .bind(reference)
    .first<{ id: string; revision: number; group_revision: number }>();
  if (!booking || booking.revision !== expectedRevision) {
    await answerCallbackBestEffort(tg, cb.id, "Карточка устарела, откройте запись в админке");
    return;
  }
  try {
    await bookingAction(
      env.DB,
      booking.id,
      { action, expectedRevision, groupRevision: booking.group_revision },
      durable.operationId,
      `telegram:${fromId}`,
      env.BOOKING_SECRET!,
    );
    await answerCallbackBestEffort(tg, cb.id, "Готово");
  } catch (error) {
    if (error instanceof DomainError) {
      await answerCallbackBestEffort(tg, cb.id, "Состояние изменилось, откройте запись в админке");
      return;
    }
    throw error;
  }
}

async function handleLeadCallback(cb: any, env: Env, tg: TelegramClient): Promise<void> {
  const chatId: number = cb.message?.chat?.id;
  const fromId: number = cb.from?.id ?? 0;
  if (!isAdmin(env, chatId, fromId)) {
    await tg.answerCallbackQuery(cb.id, "Только для администраторов");
    return;
  }
  const [, action, idStr] = cb.data.split(":");
  // Тем же parseLeadId, что и команды: callback_data приходит от клиента, и
  // «lead:take:abc» дал бы NaN в bind — D1 бросает, answerCallbackQuery уже не
  // вызывается, и кнопка у админа крутится до таймаута вместо внятного отказа.
  const leadId = parseLeadId(idStr ?? "");
  if (leadId === null) {
    await tg.answerCallbackQuery(cb.id, "Битая кнопка — обновите карточку командой /card <номер>");
    return;
  }
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

/** Номер заявки из команды: только цифры. null — админ получит подсказку про формат. */
function parseLeadId(rest: string): number | null {
  const trimmed = rest.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * /release <id> — снять исполнителя с заявки, не спрашивая, кто её взял.
 * Нужна ровно тогда, когда самообслуживание не работает: админа, взявшего
 * заявку, убрали из ADMIN_IDS, и его «Освободить» больше некому нажать.
 */
async function handleRelease(rest: string, fromId: number, env: Env, tg: TelegramClient): Promise<void> {
  const adminChat = Number(env.ADMIN_CHAT_ID);
  const leadId = parseLeadId(rest);
  if (leadId === null) {
    await tg.sendMessage(adminChat, "Формат: /release 12 — номер заявки цифрами. Номера видно в /zayavki.");
    return;
  }
  const before = await getLead(env.DB, leadId);
  if (!before) {
    await tg.sendMessage(adminChat, `Заявки #${leadId} в базе нет. Список последних: /zayavki`);
    return;
  }

  if (!(await forceReleaseLead(env.DB, leadId, fromId))) {
    // Не ошибка команды: снимать нечего. Статус перечитываем, чтобы в отказе
    // стоял настоящий — за время попытки его могли поменять кнопками.
    const now = await getLead(env.DB, leadId);
    await tg.sendMessage(
      adminChat,
      `Заявку #${leadId} освобождать не от кого — статус «${statusLabel(now?.status ?? before.status)}». ` +
      "Снять исполнителя можно только с заявки в работе. Закрытую заявку не переоткрываем.",
    );
    return;
  }

  const who = before.assigned_to_name
    ? `Снят исполнитель: ${escapeClamped(before.assigned_to_name, LIST_FIELD_LIMIT)}.`
    : "Исполнитель снят.";
  await tg.sendMessage(
    adminChat,
    `Заявка #${leadId} освобождена. ${who} Взять её теперь может любой администратор.` +
    (await refreshCard(leadId, before.telegram_message_id, env, tg)),
  );
}

/**
 * Перерисовать карточку заявки на прежнем месте. Возвращает ХВОСТ к ответу админу:
 * пустой при успехе, подсказку — если карточки нет. Неудачная перерисовка не
 * отменяет саму команду: сообщение в группе могли удалить, а заявка уже свободна.
 */
async function refreshCard(
  leadId: number,
  messageId: number | null,
  env: Env,
  tg: TelegramClient,
): Promise<string> {
  if (!messageId) return ` Карточки в группе нет — выслать: /card ${leadId}`;
  const lead = await getLead(env.DB, leadId);
  if (!lead) return "";
  try {
    const card = renderLeadCard(lead);
    await tg.editMessageText(Number(env.ADMIN_CHAT_ID), messageId, card.text, card.keyboard);
    return "";
  } catch (err) {
    console.error(`Карточка заявки #${leadId} не перерисована (${errorClass(err)})`);
    return ` Старую карточку обновить не удалось — похоже, её удалили. Выслать заново: /card ${leadId}`;
  }
}

/**
 * /card <id> — выслать карточку заявки заново, независимо от delivery_status.
 * Нужна, когда карточку удалили из группы или группу перевели в супергруппу:
 * кнопок нет, а /resend берёт только недоставленные заявки.
 *
 * Старую карточку НЕ удаляем: у бота может не быть на это прав, а история
 * группы — это ещё и то, что админы читают глазами. Вместо удаления помечаем
 * новую карточку как замену и переписываем telegram_message_id, чтобы будущие
 * перерисовки шли в неё. Нажатие на старую карточку остаётся безопасным:
 * условные UPDATE не дадут сделать переход дважды, а handleLeadCallback
 * правит то сообщение, в котором нажали.
 */
async function handleCardResend(rest: string, env: Env, tg: TelegramClient): Promise<void> {
  const adminChat = Number(env.ADMIN_CHAT_ID);
  const leadId = parseLeadId(rest);
  if (leadId === null) {
    await tg.sendMessage(adminChat, "Формат: /card 12 — номер заявки цифрами. Номера видно в /zayavki.");
    return;
  }
  const lead = await getLead(env.DB, leadId);
  if (!lead) {
    await tg.sendMessage(adminChat, `Заявки #${leadId} в базе нет. Список последних: /zayavki`);
    return;
  }

  const notice = lead.telegram_message_id
    ? `↻ Карточка выслана заново. Прежняя карточка заявки #${leadId} выше устарела — нажимайте кнопки в этой.`
    : undefined;
  if (!(await deliverCard(leadId, env, tg, notice))) {
    await tg.sendMessage(adminChat, `Карточку заявки #${leadId} отправить не удалось. Попробуйте ещё раз: /card ${leadId}`);
  }
}

async function handleAdminCommand(raw: string, fromId: number, env: Env, tg: TelegramClient): Promise<void> {
  const adminChat = Number(env.ADMIN_CHAT_ID);
  const text = stripBotMention(raw);

  if (text.startsWith("/set ")) {
    if (env.BOOKING_ENABLED === "true") {
      const adminUrl = env.ADMIN_ORIGIN ? `${env.ADMIN_ORIGIN.replace(/\/$/, "")}/admin/` : "веб-админка";
      await tg.sendMessage(adminChat, `Расписание теперь меняется только здесь: ${adminUrl}`);
      return;
    }
    const rest = text.slice("/set ".length).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx < 1) {
      await tg.sendMessage(adminChat, "Формат: /set дата_группы 15 сентября");
      return;
    }
    const alias = rest.slice(0, spaceIdx);
    // Object.hasOwn, а не прямой доступ: FACT_ALIASES — обычный литерал, и
  // `/set constructor 5` вернул бы унаследованный Object вместо undefined,
  // проскочил бы проверку на пустоту и упал бы уже в D1 — админ получил бы
  // молчание вместо подсказки «не знаю такой факт».
  const key = Object.hasOwn(FACT_ALIASES, alias) ? FACT_ALIASES[alias] : undefined;
    if (!key) {
      await tg.sendMessage(
        adminChat,
        `Не знаю факт «${escapeClamped(alias, FACT_FIELD_LIMIT)}». Сейчас можно менять только: ${Object.keys(FACT_ALIASES).join(", ")}.\nПример: /set дата_группы 15 сентября`,
      );
      return;
    }
    // Режем при ЗАПИСИ, а не только при показе: иначе обрезка спасала бы
    // подтверждение админу, но в базе осталась бы строка, ломающая всё
    // остальное, что этот факт когда-нибудь прочитает.
    const raw = rest.slice(spaceIdx + 1).trim();
    const value = truncate(raw, FACT_FIELD_LIMIT);
    const { oldValue, newValue } = await setFact(env.DB, key, value, String(fromId));
    // oldValue мог попасть в базу до появления потолка — его тоже клампим.
    await tg.sendMessage(
      adminChat,
      `${escapeClamped(alias, FACT_FIELD_LIMIT)}: «${escapeClamped(oldValue ?? "не было", FACT_FIELD_LIMIT)}» → «${escapeClamped(newValue, FACT_FIELD_LIMIT)}»` +
        (value !== raw ? `\nЗначение длинновато — сократил до ${FACT_FIELD_LIMIT} символов.` : ""),
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

  // Пробел обязателен только когда номер есть: голая «/release» тоже должна
  // отвечать подсказкой про формат, а не молчать.
  if (text === "/release" || text.startsWith("/release ")) {
    return handleRelease(text.slice("/release".length), fromId, env, tg);
  }

  if (text === "/card" || text.startsWith("/card ")) {
    return handleCardResend(text.slice("/card".length), env, tg);
  }

  if (text.startsWith("/resend")) {
    const pending = await env.DB
      .prepare("SELECT count(*) AS n FROM leads WHERE delivery_status = 'pending'")
      .first<{ n: number }>();
    const { results } = await env.DB
      .prepare(`SELECT id FROM leads WHERE delivery_status = 'pending' ORDER BY id LIMIT ${RESEND_BATCH}`)
      .all();
    let delivered = 0;
    for (const row of results as any[]) {
      if (await deliverCard(row.id, env, tg)) delivered++;
    }
    // Остаток называем явно: молча отправить 25 из 300 и отчитаться «готово»
    // означало бы, что админ считает очередь разобранной и больше не вернётся.
    const left = (pending?.n ?? 0) - delivered;
    const tail = left > 0 ? ` Осталось в очереди: ${left} — повторите /resend.` : "";
    await tg.sendMessage(adminChat, `Переотправлено карточек: ${delivered} из ${results.length}.${tail}`);
    return;
  }
}
