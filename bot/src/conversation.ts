export type FormStep = "name" | "phone" | "question" | "consent";

export interface FormData {
  name?: string;
  phone?: string;
  question?: string;
  groupId?: string;
  groupRevision?: number;
  groupSequence?: number;
  groupLabel?: string;
  bookingFlow?: boolean;
}

export interface Conversation {
  id: string;
  chatId: number;
  step: FormStep;
  data: FormData;
  submissionId: string;
  revision: number;
}

export interface ConversationFence {
  chatId: number;
  leaseToken: string;
}

const TTL_HOURS = 24;

function fenceSql(fence?: ConversationFence): { clause: string; values: unknown[] } {
  if (!fence) return { clause: "", values: [] };
  return {
    clause:
      " AND EXISTS (SELECT 1 FROM chat_leases l WHERE l.chat_id = ? AND l.lease_token = ? AND l.lease_until > datetime('now'))",
    values: [fence.chatId, fence.leaseToken],
  };
}

export async function startConversation(
  db: D1Database,
  chatId: number,
  options: { data?: FormData; fence?: ConversationFence } = {},
): Promise<Conversation | null> {
  const id = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  const fence = fenceSql(options.fence);
  const result = await db
    .prepare(
      `INSERT INTO conversations (
         id, chat_id, step, data, submission_id, revision, created_at, updated_at, expires_at
       )
       SELECT ?, ?, 'name', ?, ?, 1, datetime('now'), datetime('now'), datetime('now', '+${TTL_HOURS} hours')
       WHERE 1=1${fence.clause}
       ON CONFLICT(chat_id) DO UPDATE SET
         step = 'name', data = excluded.data,
         submission_id = excluded.submission_id, revision = conversations.revision + 1,
         created_at = datetime('now'), updated_at = datetime('now'),
         expires_at = excluded.expires_at
       WHERE 1=1${fence.clause}`,
    )
    .bind(id, chatId, JSON.stringify(options.data ?? {}), submissionId, ...fence.values, ...fence.values)
    .run();
  if (result.meta.changes === 0) return null;
  return getConversation(db, chatId);
}

interface DurableConversationInput {
  operationId: string;
  secret: string;
  fence: ConversationFence & { leaseRevision: number };
}

/**
 * Начинает новую анкету и ставит первое сообщение в одной транзакции D1.
 * Повтор того же Telegram update возвращает сохраненный результат.
 */
export async function startDurableConversation(
  db: D1Database,
  chatId: number,
  data: FormData,
  prompt: ConversationPromptInput["safeTemplateId"],
  input: DurableConversationInput,
): Promise<Conversation> {
  const existing = await db
    .prepare("SELECT id, revision, created_at FROM conversations WHERE chat_id = ?")
    .bind(chatId)
    .first<{ id: string; revision: number; created_at: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const revision = (existing?.revision ?? 0) + 1;
  const submissionId = crypto.randomUUID();
  const digest = await commandDigest(input.secret, { chatId, data, prompt });
  const fenceGuardId = `${input.operationId}:lease`;
  const statements: D1PreparedStatement[] = [
    revisionGuard(
      db,
      fenceGuardId,
      input.fence.leaseRevision,
      "SELECT revision FROM chat_leases WHERE chat_id = ? AND lease_token = ? AND lease_until > datetime('now')",
      [chatId, input.fence.leaseToken],
    ),
  ];
  if (existing) {
    const conversationGuardId = `${input.operationId}:conversation`;
    statements.push(
      revisionGuard(
        db,
        conversationGuardId,
        existing.revision,
        "SELECT revision FROM conversations WHERE id = ? AND chat_id = ?",
        [id, chatId],
      ),
      db
        .prepare(
          `UPDATE conversations
           SET step = 'name', data = ?, submission_id = ?, revision = revision + 1,
               created_at = datetime('now'), updated_at = datetime('now'),
               expires_at = datetime('now', '+${TTL_HOURS} hours')
           WHERE id = ?`,
        )
        .bind(JSON.stringify(data), submissionId, id),
      db
        .prepare(
          `UPDATE outbox SET state = 'superseded', revision = revision + 1,
             terminal_at = COALESCE(terminal_at, datetime('now')),
             lease_until = NULL, lease_token = NULL, updated_at = datetime('now')
           WHERE conversation_id = ? AND event_type = 'conversation_prompt'
             AND state IN ('pending', 'sending')`,
        )
        .bind(id),
      deleteGuard(db, conversationGuardId),
    );
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO conversations (
             id, chat_id, step, data, submission_id, revision, created_at, updated_at, expires_at
           ) VALUES (?, ?, 'name', ?, ?, 1, datetime('now'), datetime('now'), datetime('now', '+${TTL_HOURS} hours'))`,
        )
        .bind(id, chatId, JSON.stringify(data), submissionId),
    );
  }
  statements.push(
    conversationPromptStatement(db, {
      eventId: `${input.operationId}:${prompt}`,
      conversationId: id,
      conversationRevision: revision,
      safeTemplateId: prompt,
    }),
    deleteGuard(db, fenceGuardId),
  );
  await executeCommand(db, {
    operationId: input.operationId,
    scope: "telegram_conversation_start",
    payloadDigest: digest,
    resultCode: "started",
    entityId: id,
    result: { id, revision, submissionId },
    statements,
  });
  const conversation = await getConversation(db, chatId);
  if (!conversation) throw new Error("conversation_start_failed");
  return conversation;
}

export async function advanceDurableConversation(
  db: D1Database,
  conversation: Conversation,
  step: FormStep,
  data: FormData,
  prompt: ConversationPromptInput["safeTemplateId"],
  input: DurableConversationInput,
): Promise<number> {
  const nextRevision = conversation.revision + 1;
  const digest = await commandDigest(input.secret, {
    conversationId: conversation.id,
    expectedRevision: conversation.revision,
    step,
    data,
    prompt,
  });
  const conversationGuardId = `${input.operationId}:conversation`;
  const fenceGuardId = `${input.operationId}:lease`;
  const outcome = await executeCommand(db, {
    operationId: input.operationId,
    scope: "telegram_conversation_step",
    payloadDigest: digest,
    resultCode: step,
    entityId: conversation.id,
    result: { revision: nextRevision },
    statements: [
      revisionGuard(
        db,
        conversationGuardId,
        conversation.revision,
        "SELECT revision FROM conversations WHERE id = ? AND chat_id = ?",
        [conversation.id, conversation.chatId],
      ),
      revisionGuard(
        db,
        fenceGuardId,
        input.fence.leaseRevision,
        "SELECT revision FROM chat_leases WHERE chat_id = ? AND lease_token = ? AND lease_until > datetime('now')",
        [conversation.chatId, input.fence.leaseToken],
      ),
      db
        .prepare(
          `UPDATE conversations
           SET step = ?, data = ?, revision = revision + 1,
               updated_at = datetime('now'),
               expires_at = MIN(datetime(created_at, '+${TTL_HOURS} hours'), datetime('now', '+${TTL_HOURS} hours'))
           WHERE id = ?`,
        )
        .bind(step, JSON.stringify(data), conversation.id),
      db
        .prepare(
          `UPDATE outbox SET state = 'superseded', revision = revision + 1,
             terminal_at = COALESCE(terminal_at, datetime('now')),
             lease_until = NULL, lease_token = NULL, updated_at = datetime('now')
           WHERE conversation_id = ? AND event_type = 'conversation_prompt'
             AND state IN ('pending', 'sending')`,
        )
        .bind(conversation.id),
      conversationPromptStatement(db, {
        eventId: `${input.operationId}:${prompt}`,
        conversationId: conversation.id,
        conversationRevision: nextRevision,
        safeTemplateId: prompt,
      }),
      deleteGuard(db, conversationGuardId),
      deleteGuard(db, fenceGuardId),
    ],
  });
  return outcome.result.revision;
}

export async function getConversation(db: D1Database, chatId: number): Promise<Conversation | null> {
  const row = await db
    .prepare("SELECT * FROM conversations WHERE chat_id = ? AND expires_at > datetime('now')")
    .bind(chatId)
    .first<{ id: string; chat_id: number; step: FormStep; data: string; submission_id: string; revision: number }>();
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    step: row.step,
    data: JSON.parse(row.data),
    submissionId: row.submission_id,
    revision: row.revision,
  };
}

export async function updateConversation(
  db: D1Database,
  chatId: number,
  step: FormStep,
  data: FormData,
  expectedRevision?: number,
  fence?: ConversationFence,
): Promise<boolean> {
  const lease = fenceSql(fence);
  const revisionClause = expectedRevision === undefined ? "" : " AND revision = ?";
  const result = await db
    .prepare(
      `UPDATE conversations
       SET step = ?, data = ?, revision = revision + 1, updated_at = datetime('now'),
           expires_at = MIN(datetime(created_at, '+${TTL_HOURS} hours'), datetime('now', '+${TTL_HOURS} hours'))
       WHERE chat_id = ?${revisionClause}${lease.clause}`,
    )
    .bind(
      step,
      JSON.stringify(data),
      chatId,
      ...(expectedRevision === undefined ? [] : [expectedRevision]),
      ...lease.values,
    )
    .run();
  return result.meta.changes > 0;
}

export async function deleteConversation(
  db: D1Database,
  chatId: number,
  expectedRevision?: number,
  fence?: ConversationFence,
): Promise<boolean> {
  const lease = fenceSql(fence);
  const revisionClause = expectedRevision === undefined ? "" : " AND revision = ?";
  const result = await db
    .prepare(`DELETE FROM conversations WHERE chat_id = ?${revisionClause}${lease.clause}`)
    .bind(
      chatId,
      ...(expectedRevision === undefined ? [] : [expectedRevision]),
      ...lease.values,
    )
    .run();
  return result.meta.changes > 0;
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
import {
  commandDigest,
  deleteGuard,
  executeCommand,
  revisionGuard,
} from "./booking-commands";
import { conversationPromptStatement, type ConversationPromptInput } from "./outbox";
