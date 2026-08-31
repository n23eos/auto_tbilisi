export type FormStep = "name" | "phone" | "question" | "consent";

export interface FormData {
  name?: string;
  phone?: string;
  question?: string;
}

export interface Conversation {
  chatId: number;
  step: FormStep;
  data: FormData;
  submissionId: string;
}

const TTL_MINUTES = 60;

export async function startConversation(db: D1Database, chatId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversations (chat_id, step, data, submission_id, expires_at)
       VALUES (?, 'name', '{}', ?, datetime('now', '+${TTL_MINUTES} minutes'))
       ON CONFLICT(chat_id) DO UPDATE SET
         step = 'name', data = '{}',
         submission_id = excluded.submission_id, expires_at = excluded.expires_at`,
    )
    .bind(chatId, crypto.randomUUID())
    .run();
}

export async function getConversation(db: D1Database, chatId: number): Promise<Conversation | null> {
  const row = await db
    .prepare("SELECT * FROM conversations WHERE chat_id = ? AND expires_at > datetime('now')")
    .bind(chatId)
    .first<{ chat_id: number; step: FormStep; data: string; submission_id: string }>();
  if (!row) return null;
  return { chatId: row.chat_id, step: row.step, data: JSON.parse(row.data), submissionId: row.submission_id };
}

export async function updateConversation(
  db: D1Database,
  chatId: number,
  step: FormStep,
  data: FormData,
): Promise<void> {
  await db
    .prepare(
      `UPDATE conversations SET step = ?, data = ?, expires_at = datetime('now', '+${TTL_MINUTES} minutes')
       WHERE chat_id = ?`,
    )
    .bind(step, JSON.stringify(data), chatId)
    .run();
}

export async function deleteConversation(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("DELETE FROM conversations WHERE chat_id = ?").bind(chatId).run();
}

// Границы длины того, что ученик вводит в анкету. Без них одно длинное
// сообщение навсегда ломает заявку: карточка перестаёт влезать в лимит
// Telegram, sendMessage отвечает 400, заявка остаётся pending — а ученику уже
// сказали «Заявка отправлена».
export const NAME_LIMIT = 100;
export const QUESTION_LIMIT = 1000;

/** Обрезка с многоточием: сокращение должно быть видно, а не происходить молча. */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}

/** Возвращает нормализованный номер (только цифры и ведущий +) или null. */
export function validatePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s()-]/g, "");
  if (!/^\+?\d{9,15}$/.test(cleaned)) return null;
  return cleaned;
}
