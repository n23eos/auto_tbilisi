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
      // Абзац сам длиннее лимита — режем его на части без разделителя.
      for (let i = 0; i < paragraph.length; i += limit) {
        chunks.push(paragraph.slice(i, i + limit));
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class TelegramClient {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description ?? res.status}`);
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
