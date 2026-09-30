import type {
  AuditInsertInput,
  CommandOutcome,
  OutboxInsertInput,
} from "./booking-types";

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "DomainError";
  }
}

export function timestamp(date = new Date()): string {
  return date.toISOString();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function commandDigest(secret: string, payload: unknown): Promise<string> {
  if (!secret) throw new DomainError("command_secret_missing", 503);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalJson(payload)));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateOperationId(operationId: string): void {
  if (!/^[\x21-\x7E]{16,128}$/.test(operationId)) {
    throw new DomainError("invalid_idempotency_key", 400);
  }
}

interface CommandResultRow {
  scope: string;
  payload_digest: string;
  result_json: string;
  expires_at: string;
}

export async function findCommandReplay<T>(
  db: D1Database,
  operationId: string,
  scope: string,
  payloadDigest: string,
  now = new Date(),
): Promise<CommandOutcome<T> | null> {
  validateOperationId(operationId);
  const row = await db
    .prepare(
      `SELECT scope, payload_digest, result_json, expires_at
       FROM command_results WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<CommandResultRow>();
  if (!row) return null;
  if (row.scope !== scope || row.payload_digest !== payloadDigest) {
    throw new DomainError("idempotency_mismatch", 409);
  }
  if (Date.parse(row.expires_at) <= now.getTime()) {
    throw new DomainError("idempotency_expired", 409);
  }
  return { replayed: true, result: JSON.parse(row.result_json) as T };
}

export interface ExecuteCommandInput<T> {
  operationId: string;
  scope: string;
  payloadDigest: string;
  resultCode: string;
  entityId?: string | null;
  result: T;
  statements: D1PreparedStatement[];
  now?: Date;
}

export async function executeCommand<T>(
  db: D1Database,
  input: ExecuteCommandInput<T>,
): Promise<CommandOutcome<T>> {
  validateOperationId(input.operationId);
  const now = input.now ?? new Date();
  const replay = await findCommandReplay<T>(
    db,
    input.operationId,
    input.scope,
    input.payloadDigest,
    now,
  );
  if (replay) return replay;

  const createdAt = timestamp(now);
  const expiresAt = timestamp(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const saveResult = db
    .prepare(
      `INSERT INTO command_results (
         operation_id, scope, payload_digest, result_code, entity_id,
         result_json, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.operationId,
      input.scope,
      input.payloadDigest,
      input.resultCode,
      input.entityId ?? null,
      canonicalJson(input.result),
      createdAt,
      expiresAt,
    );

  try {
    await db.batch([...input.statements, saveResult]);
    return { replayed: false, result: input.result };
  } catch (error) {
    // Конкурентный повтор может завершиться после первого чтения. Уникальный
    // operation_id тогда служит блокировкой, а сохраненный безопасный результат
    // возвращается повторно без второй доменной мутации.
    const racedReplay = await findCommandReplay<T>(
      db,
      input.operationId,
      input.scope,
      input.payloadDigest,
      now,
    );
    if (racedReplay) return racedReplay;
    throw error;
  }
}

export function revisionGuard(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  actualRevisionSql: string,
  binds: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO command_guards (operation_id, expected_revision, actual_revision)
       VALUES (?, ?, (${actualRevisionSql}))`,
    )
    .bind(operationId, expectedRevision, ...binds);
}

export function deleteGuard(db: D1Database, operationId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM command_guards WHERE operation_id = ?").bind(operationId);
}

export function auditInsert(db: D1Database, input: AuditInsertInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         id, entity_type, entity_id, operation_id, actor_id, action,
         old_state, new_state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id ?? crypto.randomUUID(),
      input.entityType,
      input.entityId,
      input.operationId,
      input.actorId,
      input.action,
      input.oldState == null ? null : canonicalJson(input.oldState),
      input.newState == null ? null : canonicalJson(input.newState),
      input.createdAt ?? timestamp(),
    );
}

export function outboxInsert(db: D1Database, input: OutboxInsertInput): D1PreparedStatement {
  const createdAt = input.createdAt ?? timestamp();
  return db
    .prepare(
      `INSERT INTO outbox (
         id, event_id, booking_id, group_id, conversation_id,
         event_type, safe_template_id, conversation_revision,
         booking_revision, group_revision, recipient_key, recipient_role,
         state, retry_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id ?? crypto.randomUUID(),
      input.eventId,
      input.bookingId ?? null,
      input.groupId ?? null,
      input.conversationId ?? null,
      input.eventType,
      input.safeTemplateId,
      input.conversationRevision ?? null,
      input.bookingRevision ?? null,
      input.groupRevision ?? null,
      input.recipientKey,
      input.recipientRole,
      input.state ?? "pending",
      input.retryAt ?? null,
      createdAt,
      createdAt,
    );
}
