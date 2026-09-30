import type {
  Booking,
  BookingActionInput,
  BookingActionResult,
  BookingListItem,
  BookingListQuery,
  BookingListResult,
  BookingReceipt,
  BookingStatus,
  CommandOutcome,
  CreateBookingInput,
} from "./booking-types";
import {
  DomainError,
  auditInsert,
  commandDigest,
  deleteGuard,
  executeCommand,
  findCommandReplay,
  outboxInsert,
  revisionGuard,
  timestamp,
} from "./booking-commands";

interface BookingRow {
  id: string;
  public_reference: string;
  group_id: string | null;
  name: string | null;
  phone: string | null;
  student_chat_id: number | null;
  source: "telegram" | "site_form" | "site_chat" | "legacy";
  status: BookingStatus;
  revision: number;
  consent_version: string;
  consent_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  pii_erased_at: string | null;
  possible_duplicate?: number;
  group_start_date?: string | null;
  group_start_time?: string | null;
  group_revision?: number | null;
}

interface GroupAdmissionRow {
  id: string;
  revision: number;
  start_date: string;
  start_time: string;
  date_status: "planned" | "confirmed";
  enrollment_open: number;
  lifecycle: "scheduled" | "cancelled" | "completed";
  starts_at_utc: string;
  capacity: number;
  confirmed_count: number;
}

function mapBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    publicReference: row.public_reference,
    groupId: row.group_id,
    name: row.name,
    phone: row.phone,
    studentChatId: row.student_chat_id,
    source: row.source,
    status: row.status,
    revision: row.revision,
    consentVersion: row.consent_version,
    consentAt: row.consent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    piiErasedAt: row.pii_erased_at,
  };
}

function mapBookingListItem(row: BookingRow): BookingListItem {
  return {
    ...mapBooking(row),
    possibleDuplicate: row.possible_duplicate === 1,
    groupStartDate: row.group_start_date ?? null,
    groupStartTime: row.group_start_time ?? null,
    groupRevision: row.group_revision ?? null,
  };
}

function normalizeName(value: string): string {
  if (typeof value !== "string") throw new DomainError("invalid_name", 400);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) throw new DomainError("invalid_name", 400);
  return normalized;
}

function normalizePhone(value: string): string {
  if (typeof value !== "string") throw new DomainError("invalid_phone", 400);
  const normalized = value.replace(/[\s()-]/g, "");
  if (!/^\+\d{7,15}$/.test(normalized)) throw new DomainError("invalid_phone", 400);
  return normalized;
}

function integer(value: number, code: string): number {
  if (!Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new DomainError(code, 400);
  }
  return value;
}

function normalizedCreateInput(input: CreateBookingInput): Omit<CreateBookingInput, "consentAt"> {
  if (!input || typeof input !== "object") throw new DomainError("invalid_booking", 400);
  if (Object.keys(input).some((key) => ![
    "groupId",
    "groupRevision",
    "name",
    "phone",
    "consentVersion",
    "consentAt",
    "source",
    "studentChatId",
    "conversation",
    "fence",
  ].includes(key))) throw new DomainError("invalid_fields", 400);
  if (typeof input.groupId !== "string" || !input.groupId) throw new DomainError("invalid_group", 400);
  if (!(["telegram", "site_form", "site_chat"] as const).includes(input.source)) {
    throw new DomainError("invalid_source", 400);
  }
  if (typeof input.consentVersion !== "string" || !input.consentVersion.trim() || input.consentVersion.length > 100) {
    throw new DomainError("invalid_consent", 400);
  }
  if (input.source === "telegram") {
    if (!Number.isSafeInteger(input.studentChatId)) throw new DomainError("invalid_student_chat", 400);
  } else if (input.studentChatId !== undefined) {
    throw new DomainError("spoofed_student_chat", 400);
  }
  if (input.conversation) {
    if (!input.conversation.id || !Number.isInteger(input.conversation.revision) || input.conversation.revision < 1) {
      throw new DomainError("invalid_conversation", 400);
    }
  }
  if (input.fence) {
    if (
      !Number.isSafeInteger(input.fence.chatId)
      || !input.fence.leaseToken
      || !Number.isInteger(input.fence.leaseRevision)
      || input.fence.leaseRevision < 1
    ) throw new DomainError("invalid_fence", 400);
    if (input.studentChatId !== undefined && input.studentChatId !== input.fence.chatId) {
      throw new DomainError("invalid_fence", 400);
    }
  }
  return {
    groupId: input.groupId,
    groupRevision: integer(input.groupRevision, "invalid_group_revision"),
    name: normalizeName(input.name),
    phone: normalizePhone(input.phone),
    consentVersion: input.consentVersion.trim(),
    source: input.source,
    ...(input.studentChatId === undefined ? {} : { studentChatId: input.studentChatId }),
    ...(input.conversation ? { conversation: { ...input.conversation } } : {}),
    ...(input.fence ? { fence: { ...input.fence } } : {}),
  };
}

async function bookingPayloadDigest(secret: string, input: CreateBookingInput): Promise<string> {
  return commandDigest(secret, normalizedCreateInput(input));
}

export async function findBookingReplay(
  db: D1Database,
  input: CreateBookingInput,
  idempotencyKey: string,
  hmacSecret: string,
  now = new Date(),
): Promise<CommandOutcome<BookingReceipt> | null> {
  const digest = await bookingPayloadDigest(hmacSecret, input);
  return findCommandReplay(db, idempotencyKey, "booking.create", digest, now);
}

async function groupAdmission(db: D1Database, groupId: string): Promise<GroupAdmissionRow | null> {
  return db
    .prepare(
      `SELECT g.*,
         (SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'confirmed') AS confirmed_count
       FROM groups g WHERE g.id = ?`,
    )
    .bind(groupId)
    .first<GroupAdmissionRow>();
}

function groupPublicDetails(row: GroupAdmissionRow | null): Record<string, unknown> | undefined {
  if (!row || row.lifecycle !== "scheduled") return undefined;
  return {
    group: {
      id: row.id,
      revision: row.revision,
      startDate: row.start_date,
      startTime: row.start_time,
      dateStatus: row.date_status,
      enrollmentOpen: row.enrollment_open === 1,
      availability: row.enrollment_open === 0
        ? "closed"
        : row.confirmed_count >= row.capacity ? "full" : "open",
    },
  };
}

async function classifyAdmissionFailure(
  db: D1Database,
  input: ReturnType<typeof normalizedCreateInput>,
  now: Date,
): Promise<DomainError> {
  if (input.fence) {
    const lease = await db
      .prepare("SELECT revision, lease_token, lease_until FROM chat_leases WHERE chat_id = ?")
      .bind(input.fence.chatId)
      .first<{ revision: number; lease_token: string; lease_until: string }>();
    if (
      !lease
      || lease.revision !== input.fence.leaseRevision
      || lease.lease_token !== input.fence.leaseToken
      || Date.parse(lease.lease_until) <= now.getTime()
    ) return new DomainError("stale_lease", 409);
  }
  if (input.conversation) {
    const conversation = await db
      .prepare("SELECT revision, expires_at FROM conversations WHERE id = ?")
      .bind(input.conversation.id)
      .first<{ revision: number; expires_at: string }>();
    if (!conversation || conversation.revision !== input.conversation.revision || Date.parse(conversation.expires_at) <= now.getTime()) {
      return new DomainError("conversation_changed", 409);
    }
  }
  const group = await groupAdmission(db, input.groupId);
  const details = groupPublicDetails(group);
  if (!group || group.revision !== input.groupRevision) return new DomainError("group_changed", 409, details);
  if (group.lifecycle !== "scheduled" || group.enrollment_open !== 1 || Date.parse(group.starts_at_utc) <= now.getTime()) {
    return new DomainError("group_closed", 409, details);
  }
  if (group.confirmed_count >= group.capacity) return new DomainError("group_full", 409, details);
  return new DomainError("booking_conflict", 409, details);
}

export async function createBooking(
  db: D1Database,
  rawInput: CreateBookingInput,
  idempotencyKey: string,
  hmacSecret: string,
  now = new Date(),
): Promise<CommandOutcome<BookingReceipt>> {
  const input = normalizedCreateInput(rawInput);
  const digest = await commandDigest(hmacSecret, input);
  const replay = await findCommandReplay<BookingReceipt>(db, idempotencyKey, "booking.create", digest, now);
  if (replay) return replay;
  const createdAt = timestamp(now);
  const bookingId = crypto.randomUUID();
  const reference = `BK-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const receipt: BookingReceipt = {
    id: bookingId,
    reference,
    status: "pending",
    groupId: input.groupId,
    revision: 1,
    notificationState: "pending",
    contactMethod: input.source === "telegram" ? "telegram" : "phone",
  };
  const groupGuardId = `${idempotencyKey}:group`;
  const statements: D1PreparedStatement[] = [
    revisionGuard(
      db,
      groupGuardId,
      input.groupRevision,
      `SELECT g.revision FROM groups g
       WHERE g.id = ? AND g.lifecycle = 'scheduled' AND g.enrollment_open = 1
         AND datetime(g.starts_at_utc) > datetime(?)
         AND g.capacity > (
           SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'confirmed'
         )`,
      [input.groupId, createdAt],
    ),
  ];
  const guardIds = [groupGuardId];
  if (input.fence) {
    const fenceGuardId = `${idempotencyKey}:fence`;
    guardIds.push(fenceGuardId);
    statements.push(revisionGuard(
      db,
      fenceGuardId,
      input.fence.leaseRevision,
      `SELECT revision FROM chat_leases
       WHERE chat_id = ? AND lease_token = ? AND datetime(lease_until) > datetime(?)`,
      [input.fence.chatId, input.fence.leaseToken, createdAt],
    ));
  }
  if (input.conversation) {
    const conversationGuardId = `${idempotencyKey}:conversation`;
    guardIds.push(conversationGuardId);
    statements.push(
      revisionGuard(
        db,
        conversationGuardId,
        input.conversation.revision,
        "SELECT revision FROM conversations WHERE id = ? AND datetime(expires_at) > datetime(?)",
        [input.conversation.id, createdAt],
      ),
      db.prepare(
        `UPDATE outbox SET state = 'superseded', terminal_at = ?, updated_at = ?,
             revision = revision + 1, lease_until = NULL, lease_token = NULL
         WHERE conversation_id = ? AND conversation_revision = ?
           AND state IN ('pending', 'sending')`,
      ).bind(createdAt, createdAt, input.conversation.id, input.conversation.revision),
      db.prepare(
        `UPDATE conversations SET step = 'complete', data = '{}',
             revision = revision + 1, updated_at = ? WHERE id = ?`,
      ).bind(createdAt, input.conversation.id),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO bookings (
         id, public_reference, group_id, name, phone, student_chat_id,
         source, status, revision, consent_version, consent_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
    ).bind(
      bookingId,
      reference,
      input.groupId,
      input.name,
      input.phone,
      input.studentChatId ?? null,
      input.source,
      input.consentVersion,
      createdAt,
      createdAt,
      createdAt,
    ),
    auditInsert(db, {
      entityType: "booking",
      entityId: bookingId,
      operationId: idempotencyKey,
      actorId: input.source,
      action: "created",
      newState: { status: "pending", groupId: input.groupId, source: input.source },
      createdAt,
    }),
    outboxInsert(db, {
      eventId: `${idempotencyKey}:booking_created:staff`,
      bookingId,
      groupId: input.groupId,
      eventType: "booking_created",
      safeTemplateId: "staff_booking_created",
      recipientKey: "staff",
      recipientRole: "staff",
      createdAt,
    }),
  );
  if (input.source === "telegram") {
    statements.push(outboxInsert(db, {
      eventId: `${idempotencyKey}:booking_received:${bookingId}`,
      bookingId,
      groupId: input.groupId,
      eventType: "booking_received",
      safeTemplateId: "student_booking_received",
      bookingRevision: 1,
      recipientKey: bookingId,
      recipientRole: "student",
      createdAt,
    }));
  }
  statements.push(...guardIds.reverse().map((guardId) => deleteGuard(db, guardId)));
  try {
    return await executeCommand(db, {
      operationId: idempotencyKey,
      scope: "booking.create",
      payloadDigest: digest,
      resultCode: "created",
      entityId: bookingId,
      result: receipt,
      statements,
      now,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw await classifyAdmissionFailure(db, input, now);
  }
}

function normalizeAction(input: BookingActionInput): BookingActionInput {
  if (!input || typeof input !== "object") throw new DomainError("invalid_action", 400);
  if (Object.keys(input).some((key) => ![
    "action",
    "expectedRevision",
    "groupRevision",
    "targetGroupId",
    "targetGroupRevision",
  ].includes(key))) throw new DomainError("invalid_fields", 400);
  if (!(["confirm", "decline", "cancel", "complete", "transfer"] as const).includes(input.action)) {
    throw new DomainError("invalid_action", 400);
  }
  const normalized: BookingActionInput = {
    action: input.action,
    expectedRevision: integer(input.expectedRevision, "invalid_revision"),
    groupRevision: integer(input.groupRevision, "invalid_group_revision"),
  };
  if (input.action === "transfer") {
    if (!input.targetGroupId || input.targetGroupRevision === undefined) throw new DomainError("invalid_target_group", 400);
    normalized.targetGroupId = input.targetGroupId;
    normalized.targetGroupRevision = integer(input.targetGroupRevision, "invalid_target_revision");
  } else if (input.targetGroupId !== undefined || input.targetGroupRevision !== undefined) {
    throw new DomainError("unexpected_target_group", 400);
  }
  return normalized;
}

const ACTION_STATUS: Record<Exclude<BookingActionInput["action"], "transfer">, BookingStatus> = {
  confirm: "confirmed",
  decline: "declined",
  cancel: "cancelled",
  complete: "completed",
};

const ACTION_ALLOWED: Record<BookingActionInput["action"], BookingStatus[]> = {
  confirm: ["pending"],
  decline: ["pending"],
  cancel: ["pending", "confirmed"],
  complete: ["confirmed"],
  transfer: ["pending", "confirmed"],
};

export async function bookingAction(
  db: D1Database,
  bookingId: string,
  rawInput: BookingActionInput,
  idempotencyKey: string,
  actorId: string,
  hmacSecret: string,
  now = new Date(),
): Promise<CommandOutcome<BookingActionResult>> {
  if (!bookingId) throw new DomainError("invalid_booking", 400);
  const input = normalizeAction(rawInput);
  const digest = await commandDigest(hmacSecret, { bookingId, ...input });
  const replay = await findCommandReplay<BookingActionResult>(db, idempotencyKey, "booking.action", digest, now);
  if (replay) return replay;
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(bookingId).first<BookingRow>();
  if (!row) throw new DomainError("booking_not_found", 404);
  if (!ACTION_ALLOWED[input.action].includes(row.status)) throw new DomainError("invalid_transition", 409);
  if (!row.group_id) throw new DomainError("booking_has_no_group", 409);
  const createdAt = timestamp(now);
  const newStatus = input.action === "transfer" ? row.status : ACTION_STATUS[input.action];
  const newGroupId = input.action === "transfer" ? input.targetGroupId! : row.group_id;
  const newRevision = row.revision + 1;
  const bookingGuardId = `${idempotencyKey}:booking`;
  const sourceGroupGuardId = `${idempotencyKey}:source-group`;
  const statements: D1PreparedStatement[] = [
    revisionGuard(
      db,
      bookingGuardId,
      input.expectedRevision,
      `SELECT revision FROM bookings WHERE id = ? AND status IN (${ACTION_ALLOWED[input.action].map(() => "?").join(",")})`,
      [bookingId, ...ACTION_ALLOWED[input.action]],
    ),
    revisionGuard(db, sourceGroupGuardId, input.groupRevision, "SELECT revision FROM groups WHERE id = ?", [row.group_id]),
  ];
  const guardIds = [bookingGuardId, sourceGroupGuardId];
  if (input.action === "confirm") {
    const admissionGuardId = `${idempotencyKey}:admission`;
    guardIds.push(admissionGuardId);
    statements.push(revisionGuard(
      db,
      admissionGuardId,
      input.groupRevision,
      `SELECT g.revision FROM groups g
       WHERE g.id = ? AND g.lifecycle = 'scheduled' AND g.enrollment_open = 1
         AND datetime(g.starts_at_utc) > datetime(?)
         AND g.capacity > (
           SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'confirmed' AND b.id != ?
         )`,
      [row.group_id, createdAt, bookingId],
    ));
  }
  if (input.action === "transfer") {
    const targetGuardId = `${idempotencyKey}:target-group`;
    guardIds.push(targetGuardId);
    statements.push(revisionGuard(
      db,
      targetGuardId,
      input.targetGroupRevision!,
      `SELECT g.revision FROM groups g
       WHERE g.id = ? AND g.lifecycle = 'scheduled' AND g.enrollment_open = 1
         AND datetime(g.starts_at_utc) > datetime(?)
         AND g.capacity > (
           SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'confirmed' AND b.id != ?
         )`,
      [input.targetGroupId!, createdAt, bookingId],
    ));
  }
  const terminalAt = (["declined", "cancelled", "completed"] as BookingStatus[]).includes(newStatus) ? createdAt : null;
  statements.push(
    db.prepare(
      `UPDATE bookings SET group_id = ?, status = ?, revision = revision + 1,
         updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
       WHERE id = ?`,
    ).bind(newGroupId, newStatus, createdAt, terminalAt, bookingId),
    auditInsert(db, {
      entityType: "booking",
      entityId: bookingId,
      operationId: idempotencyKey,
      actorId,
      action: input.action,
      oldState: { status: row.status, groupId: row.group_id },
      newState: { status: newStatus, groupId: newGroupId },
      createdAt,
    }),
    outboxInsert(db, {
      eventId: `${idempotencyKey}:booking_${input.action === "transfer" ? "transferred" : newStatus}:${bookingId}`,
      bookingId,
      groupId: newGroupId,
      eventType: input.action === "transfer" ? "booking_transferred" : `booking_${newStatus}`,
      safeTemplateId: input.action === "transfer" ? "student_booking_transferred" : `student_booking_${newStatus}`,
      bookingRevision: newRevision,
      recipientKey: bookingId,
      recipientRole: "student",
      createdAt,
    }),
    ...guardIds.reverse().map((guardId) => deleteGuard(db, guardId)),
  );
  const result: BookingActionResult = {
    id: bookingId,
    status: newStatus,
    revision: newRevision,
    groupId: newGroupId,
    notificationState: "pending",
  };
  try {
    return await executeCommand(db, {
      operationId: idempotencyKey,
      scope: "booking.action",
      payloadDigest: digest,
      resultCode: "updated",
      entityId: bookingId,
      result,
      statements,
      now,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const current = await db.prepare("SELECT revision, status FROM bookings WHERE id = ?").bind(bookingId).first<{ revision: number; status: BookingStatus }>();
    if (!current) throw new DomainError("booking_not_found", 404);
    if (current.revision !== input.expectedRevision) throw new DomainError("booking_changed", 409);
    throw new DomainError(input.action === "transfer" ? "target_group_unavailable" : "group_unavailable", 409);
  }
}

function parseCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) throw new DomainError("invalid_cursor", 400);
  const createdAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || !id) throw new DomainError("invalid_cursor", 400);
  return { createdAt, id };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function listBookings(db: D1Database, query: BookingListQuery = {}): Promise<BookingListResult> {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DomainError("invalid_limit", 400);
  if (query.status !== undefined && !(["pending", "confirmed", "declined", "cancelled", "completed"] as const).includes(query.status)) {
    throw new DomainError("invalid_status", 400);
  }
  if (query.query !== undefined && (typeof query.query !== "string" || query.query.length > 100)) {
    throw new DomainError("invalid_query", 400);
  }
  const cursor = parseCursor(query.cursor);
  const search = query.query?.trim();
  const { results } = await db
    .prepare(
      `SELECT b.*, g.start_date AS group_start_date, g.start_time AS group_start_time,
         g.revision AS group_revision,
         CASE WHEN b.phone IS NOT NULL AND EXISTS (
           SELECT 1 FROM bookings duplicate
           WHERE duplicate.id != b.id AND duplicate.phone = b.phone AND duplicate.pii_erased_at IS NULL
         ) THEN 1 ELSE 0 END AS possible_duplicate
       FROM bookings b LEFT JOIN groups g ON g.id = b.group_id
       WHERE (? IS NULL OR b.group_id = ?)
         AND (? IS NULL OR b.status = ?)
         AND (? IS NULL OR b.name LIKE ? ESCAPE '\\' OR b.phone LIKE ? ESCAPE '\\' OR b.public_reference LIKE ? ESCAPE '\\')
         AND (? IS NULL OR b.created_at < ? OR (b.created_at = ? AND b.id < ?))
       ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(
      query.groupId ?? null,
      query.groupId ?? null,
      query.status ?? null,
      query.status ?? null,
      search || null,
      search ? `%${escapeLike(search)}%` : null,
      search ? `%${escapeLike(search)}%` : null,
      search ? `%${escapeLike(search)}%` : null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<BookingRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    bookings: page.map(mapBookingListItem),
    nextCursor: results.length > limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

export async function getBooking(db: D1Database, id: string): Promise<BookingListItem | null> {
  const row = await db
    .prepare(
      `SELECT b.*, g.start_date AS group_start_date, g.start_time AS group_start_time,
         g.revision AS group_revision,
         CASE WHEN b.phone IS NOT NULL AND EXISTS (
           SELECT 1 FROM bookings duplicate
           WHERE duplicate.id != b.id AND duplicate.phone = b.phone AND duplicate.pii_erased_at IS NULL
         ) THEN 1 ELSE 0 END AS possible_duplicate
       FROM bookings b LEFT JOIN groups g ON g.id = b.group_id WHERE b.id = ?`,
    )
    .bind(id)
    .first<BookingRow>();
  return row ? mapBookingListItem(row) : null;
}
