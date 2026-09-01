export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}
export interface ReplyKeyboard {
  keyboard: { text: string; request_contact?: boolean }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
}
type Keyboard = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };

// Telegram-лимит 4096 символов; берём с запасом на HTML-теги
const MESSAGE_LIMIT = 3500;

// Запас, в котором ищем начало HTML-сущности перед точкой разреза. Самая длинная
// сущность, которую производит escapeHtml, — «&amp;» (5 символов); 10 берём на
// случай других именованных сущностей, попавших в текст из базы знаний.
const MAX_ENTITY_LENGTH = 10;

/**
 * Сдвинуть точку разреза влево, если она попала ВНУТРЬ HTML-сущности.
 *
 * Тексты базы знаний экранируются на сборке (scripts/build-kb.mjs), поэтому в
 * абзаце встречаются «&amp;» и «&lt;». Разрез посреди сущности оставляет в куске
 * огрызок «&am», и Telegram отвечает на него 400 — а по кнопке меню ученик не
 * получает НИЧЕГО: апдейт к этому моменту уже помечен обработанным и не повторится.
 *
 * Если сущность не влезает в кусок целиком (лимит меньше самой сущности), режем
 * как есть: битый кусок хуже целого, но бесконечный цикл хуже обоих.
 */
function safeCut(text: string, start: number, end: number): number {
  if (end >= text.length) return end;
  const tail = text.slice(Math.max(start, end - MAX_ENTITY_LENGTH), end);
  const started = tail.match(/&[a-zA-Z0-9#]*$/);
  if (!started) return end;
  const cut = end - started[0].length;
  return cut > start ? cut : end;
}

export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    // Абзац не влезает в текущий накопленный кусок — фиксируем его как есть.
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length <= limit) {
      current = paragraph;
    } else {
      // Абзац сам длиннее лимита — режем его на части без разделителя,
      // не разрубая HTML-сущности (см. safeCut).
      for (let i = 0; i < paragraph.length; ) {
        const end = safeCut(paragraph, i, Math.min(i + limit, paragraph.length));
        chunks.push(paragraph.slice(i, end));
        i = end;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Потолок ожидания ответа api.telegram.org. Без него зависший вызов держит
 * воркер до предела времени запроса Cloudflare, и на кнопку меню ученик просто
 * не получает ничего: апдейт к этому моменту уже помечен обработанным и не
 * повторится. Десять секунд — заведомо больше нормального ответа Telegram
 * (сотни миллисекунд) и заведомо меньше терпения человека в чате.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Короче этого строка не может быть настоящим токеном бота — см. scrub(). */
const MIN_SECRET_LENGTH = 20;

export class TelegramClient {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
    private timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  /**
   * Токен бота стоит в URL запроса, а часть ошибок рантайма Workers включает
   * полный URL в текст («Fetch API cannot load: …»). Без вычистки этот текст
   * уходит в console.error, а оттуда в `wrangler tail` и Logpush — то есть
   * токен утекает в логи. Токен даёт полный доступ к боту: читать все заявки
   * и писать всем ученикам от имени школы.
   */
  private scrub(text: string): string {
    // Короткую строку не вычищаем: настоящий токен Telegram — это «цифры:35+
    // символов», меньше двадцати не бывает. А замена по строке в один-два
    // символа изуродовала бы каждое сообщение об ошибке, вырезая из него
    // обычные буквы, — и в логе осталась бы каша вместо причины падения.
    if (this.token.length < MIN_SECRET_LENGTH) return text;
    return text.replaceAll(this.token, "<ТОКЕН>");
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Обрыв по таймауту и сетевая ошибка приходят сюда одинаково. Имя метода
      // в сообщении обязательно: иначе в `wrangler tail` видно «fetch failed»
      // без единого намёка, какой именно вызов не дошёл.
      throw new Error(this.scrub(`Telegram ${method}: ${err instanceof Error ? err.message : String(err)}`));
    }
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(this.scrub(`Telegram ${method}: ${body.description ?? res.status}`));
    return body.result as T;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: Keyboard): Promise<{ message_id: number }> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  }

  /** Длинный текст — несколькими сообщениями, клавиатура на последнем. */
  async sendLong(chatId: number, text: string, replyMarkup?: Keyboard): Promise<void> {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      await this.sendMessage(chatId, parts[i], i === parts.length - 1 ? replyMarkup : undefined);
    }
  }

  editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboard): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }
}
