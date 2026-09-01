import { TelegramClient } from "./telegram";
import { escapeClamped } from "./escape";
import type { Env } from "./types";

/**
 * Пауза между оповещениями. Систематическая поломка (упал Telegram, сломалась
 * миграция) даёт ошибку на КАЖДОМ апдейте: без паузы группа админов утонула бы
 * в сотнях одинаковых сообщений, а настоящие заявки в ней потерялись бы.
 * Пять минут — админ успевает увидеть, что что-то не так, но чат остаётся
 * пригоден для работы.
 */
const THROTTLE_MS = 5 * 60 * 1000;

/** Потолок текста ошибки в сообщении: стек JS бывает на килобайты. */
const REASON_LIMIT = 500;

/**
 * Время последнего оповещения. Переменная модуля, а не запись в D1: изоляты
 * Cloudflare живут долго и обслуживают подряд много запросов, так что при
 * нагрузке этой школы паузу почти всегда считает один и тот же изолят. Цена
 * ошибки — лишнее сообщение при холодном старте, а не запись в базу на каждом
 * падении.
 */
let lastAlertAt = 0;

/** Сброс паузы между тестами: иначе первый же тест глушит все следующие. */
export function resetAlertThrottle(): void {
  lastAlertAt = 0;
}

/**
 * Сообщить админам, что бот упал. Сама НИКОГДА не бросает: её зовут из блока
 * catch, и падение оповещения не должно подменять собой исходную ошибку.
 */
export async function alertAdmins(env: Env, context: string, err: unknown): Promise<void> {
  try {
    const chatId = Number(env.ADMIN_CHAT_ID);
    // Чат админов не задан — оповещать некуда. В `wrangler tail` ошибка уже есть.
    if (!Number.isFinite(chatId) || chatId === 0) return;

    const now = Date.now();
    if (now - lastAlertAt < THROTTLE_MS) return;
    lastAlertAt = now;

    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const client = new TelegramClient(env.BOT_TOKEN, (env as any).__fetch ?? fetch);
    await client.sendMessage(
      chatId,
      `⚠️ <b>Бот дал сбой</b>\n${escapeClamped(context, REASON_LIMIT)}\n` +
        `<code>${escapeClamped(reason, REASON_LIMIT)}</code>\n\n` +
        `Следующие сбои ближайшие 5 минут не повторят это сообщение — смотрите <code>wrangler tail</code>.`,
    );
  } catch {
    // Telegram недоступен ровно тогда, когда чаще всего и падает бот.
    // Молчим: исходная ошибка уже в console.error, и подменять её нельзя.
  }
}
