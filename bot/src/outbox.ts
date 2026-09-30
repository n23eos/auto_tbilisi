import { escapeHtml } from "./escape";
import {
  auditInsert,
  commandDigest,
  deleteGuard,
  DomainError,
  executeCommand,
  revisionGuard,
} from "./booking-commands";
import type { Env } from "./types";

const LEASE_SECONDS = 60;
const RETRY_LIMIT_HOURS = 24;
const DEFAULT_BATCH = 25;

type OutboxState =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "manual_contact"
  | "resolved"
  | "superseded";

interface OutboxRow {
  id: string;
  revision: number;
  event_id: string;
  booking_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  event_type: string;
  safe_template_id: string;
  conversation_revision: number | null;
  booking_revision: number | null;
  group_revision: number | null;
  recipient_key: string;
  recipient_role: "student" | "staff" | "manual";
  state: OutboxState;
  attempts: number;
  retry_at: string | null;
  lease_token: string;
  created_at: string;
}

interface BookingDelivery {
  id: string;
  public_reference: string;
  student_chat_id: number | null;
  status: string;
  revision: number;
  pii_erased_at: string | null;
  group_id: string | null;
  start_date: string | null;
  start_time: string | null;
  group_revision: number | null;
  group_lifecycle: string | null;
}

interface ConversationDelivery {
  id: string;
  chat_id: number;
  revision: number;
  step: string;
  data: string;
}

interface TelegramResult {
  ok: boolean;
  status: number;
  messageId?: number;
  retryAfter?: number;
  errorCode?: number;
}

export interface ConversationPromptInput {
  eventId: string;
  conversationId: string;
  conversationRevision: number;
  safeTemplateId: "select_group" | "ask_name" | "ask_phone" | "ask_consent" | "form_expired";
}

export function conversationPromptStatement(
  db: D1Database,
  input: ConversationPromptInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (
         id, revision, event_id, conversation_id, event_type, safe_template_id,
         conversation_revision, recipient_key, recipient_role, state,
         attempts, retry_at, created_at, updated_at
       ) VALUES (?, 1, ?, ?, 'conversation_prompt', ?, ?, ?, 'student', 'pending',
                 0, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .bind(
      crypto.randomUUID(),
      input.eventId,
      input.conversationId,
      input.safeTemplateId,
      input.conversationRevision,
      input.conversationId,
    );
}

export async function enqueueConversationPrompt(
  db: D1Database,
  input: ConversationPromptInput,
): Promise<boolean> {
  const result = await conversationPromptStatement(db, input).run();
  return result.meta.changes > 0;
}

export async function supersedeConversationPrompts(
  db: D1Database,
  conversationId: string,
  beforeRevision?: number,
): Promise<void> {
  const revisionSql = beforeRevision === undefined ? "" : " AND conversation_revision < ?";
  await db
    .prepare(
      `UPDATE outbox
       SET state = 'superseded', revision = revision + 1,
           terminal_at = COALESCE(terminal_at, datetime('now')),
           lease_until = NULL, lease_token = NULL, updated_at = datetime('now')
       WHERE conversation_id = ? AND event_type = 'conversation_prompt'
         AND state IN ('pending', 'sending')${revisionSql}`,
    )
    .bind(conversationId, ...(beforeRevision === undefined ? [] : [beforeRevision]))
    .run();
}

function retrySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 5 * 60;
  if (attempts === 3) return 15 * 60;
  return 60 * 60;
}

async function claimNextOutbox(db: D1Database): Promise<OutboxRow | null> {
  const token = crypto.randomUUID();
  return db
    .prepare(
      `UPDATE outbox
       SET state = 'sending', attempts = attempts + 1,
           lease_until = datetime('now', '+${LEASE_SECONDS} seconds'),
           lease_token = ?, revision = revision + 1, updated_at = datetime('now')
       WHERE id = (
         SELECT id FROM outbox
         WHERE (
           (state = 'pending' AND (retry_at IS NULL OR retry_at <= datetime('now')))
           OR (state = 'sending' AND lease_until <= datetime('now'))
         )
         ORDER BY julianday(created_at), id
         LIMIT 1
       )
       RETURNING *`,
    )
    .bind(token)
    .first<OutboxRow>();
}

async function finishOutbox(
  db: D1Database,
  row: OutboxRow,
  state: "sent" | "failed" | "manual_contact" | "superseded",
  options: { messageId?: number; errorCode?: string } = {},
): Promise<boolean> {
  const terminal = state === "manual_contact" ? "terminal_at" : "COALESCE(terminal_at, datetime('now'))";
  const result = await db
    .prepare(
      `UPDATE outbox
       SET state = ?, revision = revision + 1,
           provider_message_id = COALESCE(?, provider_message_id),
           last_error_code = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END,
           terminal_at = ${terminal}, lease_until = NULL, lease_token = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND state = 'sending' AND lease_token = ?
         AND lease_until > datetime('now')`,
    )
    .bind(
      state,
      options.messageId === undefined ? null : String(options.messageId),
      options.errorCode ?? null,
      state,
      row.id,
      row.lease_token,
    )
    .run();
  return result.meta.changes > 0;
}

async function postponeOutbox(
  db: D1Database,
  row: OutboxRow,
  seconds: number,
  errorCode: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE outbox
       SET state = 'pending', revision = revision + 1,
           retry_at = datetime('now', ?), last_error_code = ?,
           lease_until = NULL, lease_token = NULL, updated_at = datetime('now')
       WHERE id = ? AND state = 'sending' AND lease_token = ?
         AND lease_until > datetime('now')`,
    )
    .bind(`+${Math.max(1, Math.floor(seconds))} seconds`, errorCode, row.id, row.lease_token)
    .run();
  return result.meta.changes > 0;
}

async function bookingFor(db: D1Database, id: string): Promise<BookingDelivery | null> {
  return db
    .prepare(
      `SELECT b.id, b.public_reference, b.student_chat_id, b.status, b.revision,
              b.pii_erased_at, b.group_id, g.start_date, g.start_time,
              g.revision AS group_revision, g.lifecycle AS group_lifecycle
       FROM bookings b
       LEFT JOIN groups g ON g.id = b.group_id
       WHERE b.id = ?`,
    )
    .bind(id)
    .first<BookingDelivery>();
}

async function conversationFor(db: D1Database, id: string): Promise<ConversationDelivery | null> {
  return db
    .prepare(
      `SELECT id, chat_id, revision, step, data
       FROM conversations WHERE id = ? AND expires_at > datetime('now')`,
    )
    .bind(id)
    .first<ConversationDelivery>();
}

function groupText(booking: BookingDelivery): string {
  if (!booking.start_date) return "группа не назначена";
  return `${escapeHtml(booking.start_date)} ${escapeHtml(booking.start_time ?? "")}`.trim();
}

function studentText(row: OutboxRow, booking: BookingDelivery): string | null {
  const reference = escapeHtml(booking.public_reference);
  const group = groupText(booking);
  const template = row.safe_template_id;
  if (template === "student_booking_received") {
    return `Заявка <b>${reference}</b> принята на группу ${group}. Ожидает подтверждения администратора.`;
  }
  if (template === "student_booking_confirmed") return `Заявка <b>${reference}</b> подтверждена. Группа: ${group}.`;
  if (template === "student_booking_declined") return `Заявка <b>${reference}</b> отклонена. Если это ошибка, свяжитесь со школой.`;
  if (template === "student_booking_cancelled") return `Заявка <b>${reference}</b> отменена.`;
  if (template === "student_booking_completed") return `Обучение по заявке <b>${reference}</b> отмечено завершенным.`;
  if (template === "student_booking_transferred") return `Заявка <b>${reference}</b> перенесена в группу ${group}.`;
  if (template === "student_group_moved") return `Дата группы по заявке <b>${reference}</b> изменена: ${group}. Если дата не подходит, свяжитесь со школой.`;
  if (template === "student_group_cancelled") return `Группа по заявке <b>${reference}</b> отменена. Администратор поможет выбрать следующий вариант.`;
  return null;
}

function staffMessage(env: Env, booking: BookingDelivery): {
  text: string;
  keyboard: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
} {
  const reference = escapeHtml(booking.public_reference);
  const group = groupText(booking);
  const origin = env.ADMIN_ORIGIN?.replace(/\/$/, "");
  const buttons: { text: string; callback_data?: string; url?: string }[][] = [];
  if (origin) buttons.push([{ text: "Открыть запись", url: `${origin}/admin/#/bookings/${encodeURIComponent(booking.id)}` }]);
  if (booking.status === "pending") {
    buttons.push([
      { text: "Подтвердить", callback_data: `bk:${booking.public_reference}:${booking.revision}:c` },
      { text: "Отклонить", callback_data: `bk:${booking.public_reference}:${booking.revision}:d` },
    ]);
  }
  return {
    text: `Новая запись <b>${reference}</b>\nГруппа: ${group}\nСтатус: ${escapeHtml(booking.status)}`,
    keyboard: { inline_keyboard: buttons },
  };
}

async function conversationMessage(
  db: D1Database,
  row: OutboxRow,
  conversation: ConversationDelivery,
): Promise<{ text: string; keyboard?: Record<string, unknown> } | null> {
  if (row.safe_template_id === "select_group") {
    const { results } = await db
      .prepare(
        `SELECT sequence, revision, start_date, start_time, date_status
         FROM groups
         WHERE service_id = 'theory_group' AND lifecycle = 'scheduled'
           AND enrollment_open = 1 AND datetime(starts_at_utc) > datetime('now')
           AND (SELECT count(*) FROM bookings b
                WHERE b.group_id = groups.id AND b.status = 'confirmed') < capacity
         ORDER BY starts_at_utc LIMIT 3`,
      )
      .all<{
        sequence: number;
        revision: number;
        start_date: string;
        start_time: string;
        date_status: string;
      }>();
    if (results.length === 0) return { text: "Сейчас нет открытых групп. Свяжитесь со школой, и администратор подскажет следующий старт." };
    return {
      text: "Выберите ближайшую группу:",
      keyboard: {
        inline_keyboard: results.map((group) => [{
          text: `${group.start_date} ${group.start_time}${group.date_status === "planned" ? " (предварительно)" : ""}`,
          callback_data: `bg:${group.sequence}:${group.revision}`,
        }]),
      },
    };
  }
  if (row.safe_template_id === "ask_name") return { text: "Как вас зовут?" };
  if (row.safe_template_id === "ask_phone") {
    return {
      text: "Ваш телефон? Можно нажать кнопку ниже или ввести вручную.",
      keyboard: {
        keyboard: [[{ text: "Поделиться контактом", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
  }
  if (row.safe_template_id === "ask_consent") {
    const data = JSON.parse(conversation.data) as { groupLabel?: string };
    return {
      text:
        `Группа: ${escapeHtml(data.groupLabel ?? "выбранная группа")}. ` +
        "Нажимая Согласен, вы разрешаете школе использовать номер, чтобы связаться по записи.",
      keyboard: {
        inline_keyboard: [[
          { text: "Согласен", callback_data: `bf:${conversation.revision}:yes` },
          { text: "Отмена", callback_data: `bf:${conversation.revision}:no` },
        ]],
      },
    };
  }
  if (row.safe_template_id === "form_expired") return { text: "Анкета устарела. Откройте запись заново из меню." };
  return null;
}

async function telegramSend(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: Record<string, unknown>,
): Promise<TelegramResult> {
  const fetchFn = env.__fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: keyboard }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status };
  }
  return {
    ok: response.ok && body?.ok === true,
    status: response.status,
    messageId: body?.result?.message_id,
    retryAfter: body?.parameters?.retry_after,
    errorCode: body?.error_code,
  };
}

async function deliverOne(env: Env, row: OutboxRow): Promise<TelegramResult | "superseded" | "manual"> {
  if (row.recipient_role === "manual") return "manual";

  if (row.conversation_id) {
    const conversation = await conversationFor(env.DB, row.conversation_id);
    if (!conversation || conversation.revision !== row.conversation_revision) return "superseded";
    const rendered = await conversationMessage(env.DB, row, conversation);
    if (!rendered) return { ok: false, status: 422 };
    return telegramSend(env, conversation.chat_id, rendered.text, rendered.keyboard);
  }

  if (!row.booking_id) return { ok: false, status: 422 };
  const booking = await bookingFor(env.DB, row.booking_id);
  if (!booking) return "superseded";
  if (row.booking_revision !== null && booking.revision !== row.booking_revision) return "superseded";
  if (row.group_revision !== null && booking.group_revision !== row.group_revision) return "superseded";

  if (row.recipient_role === "staff") {
    const rendered = staffMessage(env, booking);
    return telegramSend(env, Number(env.ADMIN_CHAT_ID), rendered.text, rendered.keyboard);
  }

  if (booking.pii_erased_at || booking.student_chat_id === null) return "manual";
  const text = studentText(row, booking);
  if (!text) return { ok: false, status: 422 };
  return telegramSend(env, booking.student_chat_id, text);
}

export async function dispatchOutbox(
  env: Env,
  options: { limit?: number; afterSend?: (row: { id: string }) => Promise<void> } = {},
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < (options.limit ?? DEFAULT_BATCH); i += 1) {
    const row = await claimNextOutbox(env.DB);
    if (!row) break;
    const result = await deliverOne(env, row);
    if (result === "superseded") {
      await finishOutbox(env.DB, row, "superseded", { errorCode: "stale_version" });
      continue;
    }
    if (result === "manual") {
      await finishOutbox(env.DB, row, "manual_contact", { errorCode: "telegram_unavailable" });
      continue;
    }
    if (result.ok) {
      if (options.afterSend) await options.afterSend({ id: row.id });
      if (await finishOutbox(env.DB, row, "sent", { messageId: result.messageId })) sent += 1;
      continue;
    }

    const permanent = result.status === 403 || result.errorCode === 403;
    if (permanent) {
      await finishOutbox(env.DB, row, "manual_contact", { errorCode: "telegram_forbidden" });
      continue;
    }
    const createdAt = Date.parse(row.created_at.endsWith("Z") ? row.created_at : `${row.created_at}Z`);
    const tooOld = Date.now() - createdAt >= RETRY_LIMIT_HOURS * 60 * 60 * 1000;
    if (tooOld) {
      await finishOutbox(env.DB, row, row.recipient_role === "student" ? "manual_contact" : "failed", {
        errorCode: "retry_expired",
      });
      continue;
    }
    const delay = result.retryAfter ?? retrySeconds(row.attempts);
    await postponeOutbox(env.DB, row, delay, result.status === 429 || result.errorCode === 429 ? "rate_limited" : "delivery_error");
  }
  return sent;
}

export async function listNotifications(
  db: D1Database,
  state?: string,
  cursor?: string,
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (state) {
    where.push("o.state = ?");
    values.push(state);
  } else {
    where.push("o.state IN ('failed', 'manual_contact')");
  }
  if (cursor) {
    where.push("o.id > ?");
    values.push(cursor);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT o.id, o.revision, o.event_type, o.recipient_role, o.state, o.attempts,
              o.last_error_code, o.created_at, o.updated_at, o.booking_id,
              b.public_reference
       FROM outbox o LEFT JOIN bookings b ON b.id = o.booking_id
       ${clause} ORDER BY o.id LIMIT 51`,
    )
    .bind(...values)
    .all<Record<string, unknown>>();
  const hasMore = results.length > 50;
  const items = results.slice(0, 50);
  return { items, nextCursor: hasMore ? String(items.at(-1)?.id) : null };
}

export async function notificationAction(
  db: D1Database,
  id: string,
  input: { action: "retry" | "contacted"; expected_revision: number },
  key: string,
  actor: string,
  secret: string,
): Promise<Record<string, unknown>> {
  if (input.action !== "retry" && input.action !== "contacted") {
    throw new DomainError("invalid_notification_action", 400);
  }
  if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) {
    throw new DomainError("invalid_revision", 400);
  }
  const state = input.action === "retry" ? "pending" : "resolved";
  const result = {
    id,
    revision: input.expected_revision + 1,
    state,
  };
  const digest = await commandDigest(secret, { id, input });
  const guardId = `${key}:notification`;
  const retryContact = input.action === "retry"
    ? `AND (
         julianday(o.created_at) > julianday('now', '-${RETRY_LIMIT_HOURS} hours')
         AND (
         o.recipient_role = 'staff'
         OR (o.conversation_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM conversations c
           WHERE c.id = o.conversation_id AND c.expires_at > datetime('now')
         ))
         OR (o.booking_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.id = o.booking_id AND b.pii_erased_at IS NULL
             AND (o.recipient_role != 'student' OR b.student_chat_id IS NOT NULL)
         ))
       )
       )`
    : "";
  const guard = revisionGuard(
    db,
    guardId,
    input.expected_revision,
    `SELECT o.revision FROM outbox o
     WHERE o.id = ? AND o.state IN ('failed', 'manual_contact') ${retryContact}`,
    [id],
  );
  const update = db
    .prepare(
      `UPDATE outbox
       SET state = ?, revision = revision + 1,
           retry_at = CASE WHEN ? = 'retry' THEN datetime('now') ELSE retry_at END,
           resolved_at = CASE WHEN ? = 'contacted' THEN datetime('now') ELSE resolved_at END,
           resolved_by_actor = CASE WHEN ? = 'contacted' THEN ? ELSE resolved_by_actor END,
           terminal_at = CASE WHEN ? = 'contacted' THEN COALESCE(terminal_at, datetime('now')) ELSE terminal_at END,
           lease_until = NULL, lease_token = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(state, input.action, input.action, input.action, actor, input.action, id);
  try {
    const outcome = await executeCommand(db, {
      operationId: key,
      scope: "notification_action",
      payloadDigest: digest,
      resultCode: state,
      entityId: id,
      result,
      statements: [
        guard,
        update,
        auditInsert(db, {
          entityType: "notification",
          entityId: id,
          operationId: key,
          actorId: actor,
          action: input.action,
          oldState: null,
          newState: { state },
        }),
        deleteGuard(db, guardId),
      ],
    });
    return outcome.result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("notification_conflict", 409);
  }
}
