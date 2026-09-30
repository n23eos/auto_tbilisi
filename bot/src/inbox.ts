import type { Env } from "./types";

const PAYLOAD_TTL_HOURS = 24;
const MARKER_TTL_DAYS = 7;
const LEASE_SECONDS = 60;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_BATCH = 25;

export interface InboxFence {
  chatId: number;
  leaseToken: string;
  leaseRevision: number;
}

export interface InboxClaim {
  updateId: number;
  update: any;
  attempts: number;
  fence: InboxFence;
}

export type InboxHandler = (
  update: any,
  env: Env,
  context: { operationId: string; fence: InboxFence },
) => Promise<void>;

function chatIdOf(update: any): number | null {
  const value = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function retrySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 5 * 60;
  if (attempts === 3) return 15 * 60;
  return 60 * 60;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "processing_error";
}

async function inboxOperationId(env: Env, updateId: number): Promise<string> {
  if (!env.BOOKING_SECRET) return `telegram-update:${updateId}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BOOKING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(String(updateId))),
  );
  const suffix = [...signature.slice(0, 12)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `tg:${updateId}:${suffix}`;
}

/**
 * Сохраняет Telegram update до ответа 200. Повтор update_id не меняет
 * attempts и retry_at уже принятого события.
 */
export async function acceptInboxUpdate(db: D1Database, update: any): Promise<boolean> {
  if (!Number.isSafeInteger(update?.update_id)) throw new TypeError("invalid_update_id");
  const payload = JSON.stringify(update);
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError("update_too_large");
  }

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO inbox (
         update_id, chat_id, payload, state, attempts, retry_at,
         created_at, updated_at, payload_expires_at, expires_at
       ) VALUES (
         ?, ?, ?, 'pending', 0, datetime('now'),
         datetime('now'), datetime('now'),
         datetime('now', '+${PAYLOAD_TTL_HOURS} hours'),
         datetime('now', '+${MARKER_TTL_DAYS} days')
       )`,
    )
    .bind(update.update_id, chatIdOf(update), payload)
    .run();
  return result.meta.changes > 0;
}

/** Берет только самое раннее незавершенное событие свободного чата. */
export async function claimNextInbox(db: D1Database): Promise<InboxClaim | null> {
  const candidate = await db
    .prepare(
      `SELECT i.update_id, i.chat_id, i.payload
       FROM inbox i
       WHERE i.chat_id IS NOT NULL
         AND i.payload IS NOT NULL
         AND i.payload_expires_at > datetime('now')
         AND (
           i.state IN ('pending', 'failed')
           OR (i.state = 'processing' AND i.lease_until <= datetime('now'))
         )
         AND (i.retry_at IS NULL OR i.retry_at <= datetime('now'))
         AND NOT EXISTS (
           SELECT 1 FROM inbox earlier
           WHERE earlier.chat_id = i.chat_id
             AND earlier.update_id < i.update_id
             AND earlier.state != 'done'
             AND earlier.payload IS NOT NULL
             AND earlier.payload_expires_at > datetime('now')
         )
         AND NOT EXISTS (
           SELECT 1 FROM chat_leases active
           WHERE active.chat_id = i.chat_id
             AND active.lease_until > datetime('now')
         )
       ORDER BY i.update_id
       LIMIT 1`,
    )
    .first<{ update_id: number; chat_id: number; payload: string }>();
  if (!candidate) return null;

  const leaseToken = crypto.randomUUID();
  const lease = await db
    .prepare(
      `INSERT INTO chat_leases (chat_id, lease_until, lease_token, revision, updated_at)
       VALUES (?, datetime('now', '+${LEASE_SECONDS} seconds'), ?, 1, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET
         lease_until = excluded.lease_until,
         lease_token = excluded.lease_token,
         revision = chat_leases.revision + 1,
         updated_at = datetime('now')
       WHERE chat_leases.lease_until <= datetime('now')`,
    )
    .bind(candidate.chat_id, leaseToken)
    .run();
  if (lease.meta.changes === 0) return null;

  const leaseRow = await db
    .prepare("SELECT revision FROM chat_leases WHERE chat_id = ? AND lease_token = ?")
    .bind(candidate.chat_id, leaseToken)
    .first<{ revision: number }>();
  if (!leaseRow) return null;

  const claimed = await db
    .prepare(
      `UPDATE inbox
       SET state = 'processing', attempts = attempts + 1,
           lease_until = datetime('now', '+${LEASE_SECONDS} seconds'),
           lease_token = ?, updated_at = datetime('now')
       WHERE update_id = ?
         AND payload IS NOT NULL
         AND payload_expires_at > datetime('now')
         AND (retry_at IS NULL OR retry_at <= datetime('now'))
         AND (
           state IN ('pending', 'failed')
           OR (state = 'processing' AND lease_until <= datetime('now'))
         )
         AND EXISTS (
           SELECT 1 FROM chat_leases
           WHERE chat_id = ? AND lease_token = ? AND revision = ?
             AND lease_until > datetime('now')
         )`,
    )
    .bind(leaseToken, candidate.update_id, candidate.chat_id, leaseToken, leaseRow.revision)
    .run();
  if (claimed.meta.changes === 0) {
    await releaseChatLease(db, candidate.chat_id, leaseToken, leaseRow.revision);
    return null;
  }

  const attempts = await db
    .prepare("SELECT attempts FROM inbox WHERE update_id = ?")
    .bind(candidate.update_id)
    .first<{ attempts: number }>();
  return {
    updateId: candidate.update_id,
    update: JSON.parse(candidate.payload),
    attempts: attempts?.attempts ?? 1,
    fence: { chatId: candidate.chat_id, leaseToken, leaseRevision: leaseRow.revision },
  };
}

async function releaseChatLease(
  db: D1Database,
  chatId: number,
  leaseToken: string,
  leaseRevision: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE chat_leases SET lease_until = datetime('now'), updated_at = datetime('now')
       WHERE chat_id = ? AND lease_token = ? AND revision = ?`,
    )
    .bind(chatId, leaseToken, leaseRevision)
    .run();
}

export async function completeInbox(db: D1Database, claim: InboxClaim): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE inbox
       SET state = 'done', payload = NULL, chat_id = NULL,
           retry_at = NULL, lease_until = NULL, lease_token = NULL,
           last_error_code = NULL, completed_at = datetime('now'), updated_at = datetime('now')
       WHERE update_id = ? AND state = 'processing' AND lease_token = ?
         AND EXISTS (
           SELECT 1 FROM chat_leases
           WHERE chat_id = ? AND lease_token = ? AND revision = ?
             AND lease_until > datetime('now')
         )`,
    )
    .bind(
      claim.updateId,
      claim.fence.leaseToken,
      claim.fence.chatId,
      claim.fence.leaseToken,
      claim.fence.leaseRevision,
    )
    .run();
  await releaseChatLease(
    db,
    claim.fence.chatId,
    claim.fence.leaseToken,
    claim.fence.leaseRevision,
  );
  return result.meta.changes > 0;
}

export async function failInbox(
  db: D1Database,
  claim: InboxClaim,
  error: unknown,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE inbox
       SET state = 'failed', retry_at = datetime('now', ?),
           lease_until = NULL, lease_token = NULL, last_error_code = ?, updated_at = datetime('now')
       WHERE update_id = ? AND state = 'processing' AND lease_token = ?
         AND EXISTS (
           SELECT 1 FROM chat_leases
           WHERE chat_id = ? AND lease_token = ? AND revision = ?
             AND lease_until > datetime('now')
         )`,
    )
    .bind(
      `+${retrySeconds(claim.attempts)} seconds`,
      errorCode(error),
      claim.updateId,
      claim.fence.leaseToken,
      claim.fence.chatId,
      claim.fence.leaseToken,
      claim.fence.leaseRevision,
    )
    .run();
  await releaseChatLease(
    db,
    claim.fence.chatId,
    claim.fence.leaseToken,
    claim.fence.leaseRevision,
  );
  return result.meta.changes > 0;
}

export async function drainInbox(
  env: Env,
  handler: InboxHandler,
  limit = DEFAULT_BATCH,
): Promise<number> {
  let completed = 0;
  for (let i = 0; i < limit; i += 1) {
    const claim = await claimNextInbox(env.DB);
    if (!claim) break;
    try {
      const operationId = await inboxOperationId(env, claim.updateId);
      // В новом контуре command result пишется в той же D1 batch, что и шаг
      // анкеты или booking. Если isolate упал после commit, повтор inbox должен
      // только закрыть marker, иначе тот же текст будет разобран уже на новом шаге.
      const committed = await env.DB
        .prepare("SELECT 1 AS committed FROM command_results WHERE operation_id = ?")
        .bind(operationId)
        .first<{ committed: number }>();
      if (committed) {
        if (await completeInbox(env.DB, claim)) completed += 1;
        continue;
      }
      await handler(claim.update, env, {
        operationId,
        fence: claim.fence,
      });
      if (await completeInbox(env.DB, claim)) completed += 1;
    } catch (error) {
      await failInbox(env.DB, claim, error);
      console.error(`Inbox update_id=${claim.updateId} не обработан (${errorCode(error)})`);
    }
  }
  return completed;
}
