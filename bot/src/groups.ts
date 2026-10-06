import {
  THEORY_SERVICE_ID,
  TBILISI_TIMEZONE,
  type AdminGroup,
  type CommandOutcome,
  type Group,
  type GroupListQuery,
  type GroupListResult,
  type GroupPatch,
  type PublicGroupsSnapshot,
  type ScheduleChange,
  type ScheduleCommand,
  type ScheduleCommitResult,
  type SchedulePreview,
} from "./booking-types";
import {
  DomainError,
  auditInsert,
  canonicalJson,
  commandDigest,
  deleteGuard,
  executeCommand,
  findCommandReplay,
  revisionGuard,
  timestamp,
} from "./booking-commands";

interface GroupRow {
  id: string;
  service_id: string;
  sequence: number;
  start_date: string;
  start_time: string;
  timezone: typeof TBILISI_TIMEZONE;
  starts_at_utc: string;
  date_status: "planned" | "confirmed";
  enrollment_open: number;
  lifecycle: "scheduled" | "cancelled" | "completed";
  capacity: number;
  revision: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  pending_count?: number;
  confirmed_count?: number;
}

function mapGroup(row: GroupRow): Group {
  return {
    id: row.id,
    serviceId: row.service_id,
    sequence: row.sequence,
    startDate: row.start_date,
    startTime: row.start_time,
    timezone: row.timezone,
    startsAtUtc: row.starts_at_utc,
    dateStatus: row.date_status,
    enrollmentOpen: row.enrollment_open === 1,
    lifecycle: row.lifecycle,
    capacity: row.capacity,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
  };
}

function serviceId(value?: string): typeof THEORY_SERVICE_ID {
  if (value !== undefined && value !== THEORY_SERVICE_ID) {
    throw new DomainError("invalid_service", 400);
  }
  return THEORY_SERVICE_ID;
}

function integer(value: number, code: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new DomainError(code, 400);
  return value;
}

function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError("invalid_date", 400);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) throw new DomainError("invalid_date", 400);
  return value;
}

function validTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new DomainError("invalid_time", 400);
  return value;
}

function addDays(value: string, days: number): string {
  const [year, month, day] = validDate(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function dayDelta(from: string, to: string): number {
  return Math.round((Date.parse(`${validDate(to)}T00:00:00Z`) - Date.parse(`${validDate(from)}T00:00:00Z`)) / 86_400_000);
}

function startsAtUtc(date: string, time: string): string {
  validDate(date);
  validTime(time);
  const instant = new Date(`${date}T${time}:00+04:00`);
  if (!Number.isFinite(instant.getTime())) throw new DomainError("invalid_date", 400);
  return instant.toISOString().replace(".000Z", "Z");
}

function assertFuture(date: string, time: string, now: Date): void {
  if (Date.parse(startsAtUtc(date, time)) <= now.getTime()) throw new DomainError("date_in_past", 409);
}

function exactKeys(value: object, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new DomainError("invalid_fields", 400);
  }
}

function normalizeCommand(command: ScheduleCommand): ScheduleCommand {
  if (!command || typeof command !== "object") throw new DomainError("invalid_command", 400);
  integer(command.expectedRevision, "invalid_revision", 1, Number.MAX_SAFE_INTEGER);
  const base = { expectedRevision: command.expectedRevision, serviceId: serviceId(command.serviceId) };
  switch (command.action) {
    case "create":
      exactKeys(command, ["action", "expectedRevision", "serviceId", "firstDate", "startTime", "count", "capacity"]);
      return {
        ...base,
        action: "create",
        firstDate: validDate(command.firstDate),
        startTime: validTime(command.startTime),
        count: integer(command.count, "invalid_count", 1, 3),
        capacity: integer(command.capacity, "invalid_capacity", 1, 100),
      };
    case "append":
      exactKeys(command, ["action", "expectedRevision", "serviceId", "lastGroupId"]);
      if (typeof command.lastGroupId !== "string" || !command.lastGroupId) throw new DomainError("invalid_group", 400);
      return { ...base, action: "append", lastGroupId: command.lastGroupId };
    case "move":
      exactKeys(command, ["action", "expectedRevision", "serviceId", "groupId", "newDate", "newTime", "scope", "ackConfirmedMove"]);
      if (typeof command.groupId !== "string" || !command.groupId) throw new DomainError("invalid_group", 400);
      if (command.scope !== "one" && command.scope !== "following_planned") {
        throw new DomainError("invalid_scope", 400);
      }
      if (typeof command.ackConfirmedMove !== "boolean") throw new DomainError("invalid_ack", 400);
      return {
        ...base,
        action: "move",
        groupId: command.groupId,
        newDate: validDate(command.newDate),
        newTime: validTime(command.newTime),
        scope: command.scope,
        ackConfirmedMove: command.ackConfirmedMove,
      };
    case "cancel":
      exactKeys(command, ["action", "expectedRevision", "serviceId", "groupId"]);
      if (typeof command.groupId !== "string" || !command.groupId) throw new DomainError("invalid_group", 400);
      return { ...base, action: "cancel", groupId: command.groupId };
    default:
      throw new DomainError("invalid_action", 400);
  }
}

async function scheduleRevision(db: D1Database, service: string): Promise<number> {
  const row = await db.prepare("SELECT revision FROM schedule_state WHERE service_id = ?").bind(service).first<{ revision: number }>();
  if (!row) throw new DomainError("schedule_unavailable", 503);
  return row.revision;
}

async function scheduleSnapshot(
  db: D1Database,
  service: string,
): Promise<{ revision: number; rows: GroupRow[] }> {
  const [stateResult, groupsResult] = await db.batch([
    db.prepare("SELECT revision FROM schedule_state WHERE service_id = ?").bind(service),
    db.prepare("SELECT * FROM groups WHERE service_id = ? ORDER BY sequence").bind(service),
  ]);
  const state = stateResult.results[0] as { revision: number } | undefined;
  if (!state) throw new DomainError("schedule_unavailable", 503);
  return { revision: state.revision, rows: groupsResult.results as unknown as GroupRow[] };
}

async function affectedBookingCount(db: D1Database, groupIds: string[]): Promise<number> {
  if (groupIds.length === 0) return 0;
  const placeholders = groupIds.map(() => "?").join(",");
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM bookings WHERE group_id IN (${placeholders}) AND status IN ('pending', 'confirmed')`)
    .bind(...groupIds)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function publicGroups(db: D1Database, now = new Date()): Promise<PublicGroupsSnapshot> {
  const [stateResult, groupsResult] = await db.batch([
    db.prepare("SELECT revision FROM schedule_state WHERE service_id = ?").bind(THEORY_SERVICE_ID),
    db.prepare(
      `SELECT g.*,
         (SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'confirmed') AS confirmed_count
       FROM groups g
       WHERE g.service_id = ? AND g.lifecycle = 'scheduled' AND datetime(g.starts_at_utc) > datetime(?)
       ORDER BY g.starts_at_utc, g.id LIMIT 3`,
    )
      .bind(THEORY_SERVICE_ID, timestamp(now)),
  ]);
  const state = stateResult.results[0] as { revision: number } | undefined;
  if (!state) throw new DomainError("schedule_unavailable", 503);
  const results = groupsResult.results as unknown as GroupRow[];
  return {
    scheduleRevision: state.revision,
    fetchedAt: timestamp(now),
    timezone: TBILISI_TIMEZONE,
    groups: results.map((row) => ({
      id: row.id,
      revision: row.revision,
      startDate: row.start_date,
      startTime: row.start_time,
      dateStatus: row.date_status,
      enrollmentOpen: row.enrollment_open === 1,
      availability: row.enrollment_open === 0
        ? "closed"
        : (row.confirmed_count ?? 0) >= row.capacity ? "full" : "open",
    })),
  };
}

export async function listGroups(db: D1Database, query: GroupListQuery = {}): Promise<GroupListResult> {
  const service = serviceId(query.serviceId);
  const limit = integer(query.limit ?? 50, "invalid_limit", 1, 50);
  const cursor = query.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(query.cursor);
  if (!Number.isInteger(cursor) || cursor < 1) throw new DomainError("invalid_cursor", 400);
  const now = query.now ?? new Date();
  const history = query.includeHistory === true;
  const [stateResult, groupsResult] = await db.batch([
    db.prepare("SELECT revision FROM schedule_state WHERE service_id = ?").bind(service),
    db.prepare(
      `SELECT g.*,
         (SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'pending') AS pending_count,
         (SELECT COUNT(*) FROM bookings b WHERE b.group_id = g.id AND b.status = 'confirmed') AS confirmed_count
       FROM groups g
       WHERE g.service_id = ? AND g.sequence < ?
         AND (? = 1 OR (g.lifecycle = 'scheduled' AND datetime(g.starts_at_utc) > datetime(?)))
       ORDER BY g.sequence DESC LIMIT ?`,
    )
      .bind(service, cursor, history ? 1 : 0, timestamp(now), limit + 1),
  ]);
  const state = stateResult.results[0] as { revision: number } | undefined;
  if (!state) throw new DomainError("schedule_unavailable", 503);
  const results = groupsResult.results as unknown as GroupRow[];
  const page = results.slice(0, limit);
  return {
    scheduleRevision: state.revision,
    groups: page.map((row): AdminGroup => ({
      ...mapGroup(row),
      pendingCount: row.pending_count ?? 0,
      confirmedCount: row.confirmed_count ?? 0,
    })),
    nextCursor: results.length > limit ? String(page[page.length - 1].sequence) : null,
  };
}

export async function previewSchedule(
  db: D1Database,
  rawCommand: ScheduleCommand,
  now = new Date(),
): Promise<SchedulePreview> {
  const command = normalizeCommand(rawCommand);
  const service = serviceId(command.serviceId);
  const snapshot = await scheduleSnapshot(db, service);
  const revision = snapshot.revision;
  if (revision !== command.expectedRevision) throw new DomainError("schedule_changed", 409);
  const rows = snapshot.rows;
  const future = rows.filter((row) => row.lifecycle === "scheduled" && Date.parse(row.starts_at_utc) > now.getTime());
  let changes: ScheduleChange[] = [];
  const warnings: string[] = [];

  if (command.action === "create") {
    if (future.length !== 0) throw new DomainError("schedule_exists", 409);
    const firstSequence = rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
    changes = Array.from({ length: command.count }, (_, index) => {
      const date = addDays(command.firstDate, index * 14);
      assertFuture(date, command.startTime, now);
      return {
        id: null,
        sequence: firstSequence + index,
        oldDate: null,
        newDate: date,
        oldTime: null,
        newTime: command.startTime,
        oldDateStatus: null,
        newDateStatus: "planned",
        lifecycle: "scheduled",
      };
    });
  } else if (command.action === "append") {
    if (future.length === 0) throw new DomainError("schedule_empty", 409);
    if (future.length >= 3) throw new DomainError("group_future_limit", 409);
    const last = future.reduce((current, row) => row.sequence > current.sequence ? row : current);
    if (last.id !== command.lastGroupId) throw new DomainError("last_group_changed", 409);
    const date = addDays(last.start_date, 14);
    assertFuture(date, last.start_time, now);
    changes = [{
      id: null,
      sequence: rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1,
      oldDate: null,
      newDate: date,
      oldTime: null,
      newTime: last.start_time,
      oldDateStatus: null,
      newDateStatus: "planned",
      lifecycle: "scheduled",
    }];
  } else {
    const selected = rows.find((row) => row.id === command.groupId);
    if (!selected || selected.lifecycle !== "scheduled" || Date.parse(selected.starts_at_utc) <= now.getTime()) {
      throw new DomainError("group_not_found", 404);
    }
    if (command.action === "cancel") {
      changes = [{
        id: selected.id,
        sequence: selected.sequence,
        oldDate: selected.start_date,
        newDate: null,
        oldTime: selected.start_time,
        newTime: null,
        oldDateStatus: selected.date_status,
        newDateStatus: selected.date_status,
        lifecycle: "cancelled",
      }];
    } else {
      if (selected.date_status === "confirmed" && !command.ackConfirmedMove) {
        throw new DomainError("confirmed_move_requires_ack", 409);
      }
      const delta = dayDelta(selected.start_date, command.newDate);
      const moving = command.scope === "one"
        ? [selected]
        : rows.filter((row) => row.lifecycle === "scheduled" && row.sequence >= selected.sequence);
      if (command.scope === "following_planned" && moving.slice(1).some((row) => row.date_status === "confirmed")) {
        throw new DomainError("confirmed_conflict", 409);
      }
      const movingIds = new Set(moving.map((row) => row.id));
      const occupied = new Set(
        rows.filter((row) => row.lifecycle === "scheduled" && !movingIds.has(row.id)).map((row) => row.start_date),
      );
      changes = moving.map((row, index) => {
        const date = index === 0 ? command.newDate : addDays(row.start_date, delta);
        const time = index === 0 ? command.newTime : row.start_time;
        assertFuture(date, time, now);
        if (occupied.has(date)) throw new DomainError("date_collision", 409);
        occupied.add(date);
        return {
          id: row.id,
          sequence: row.sequence,
          oldDate: row.start_date,
          newDate: date,
          oldTime: row.start_time,
          newTime: time,
          oldDateStatus: row.date_status,
          newDateStatus: index === 0 && row.date_status === "confirmed" ? "planned" : row.date_status,
          lifecycle: "scheduled",
        };
      });
      if (selected.date_status === "confirmed") warnings.push("confirmed_start_will_reset");
    }
  }

  const affectedBookings = await affectedBookingCount(db, changes.flatMap((change) => change.id ? [change.id] : []));
  return {
    expectedRevision: command.expectedRevision,
    normalizedCommand: command,
    changes,
    affectedBookings,
    notificationCount: affectedBookings,
    warnings,
  };
}

function groupNotificationInsert(
  db: D1Database,
  operationId: string,
  groupId: string,
  eventType: "group_moved" | "group_cancelled",
  templateId: "student_group_moved" | "student_group_cancelled",
  createdAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (
         id, event_id, booking_id, group_id, event_type, safe_template_id,
         booking_revision, group_revision, recipient_key, recipient_role,
         state, created_at, updated_at
       )
       SELECT lower(hex(randomblob(16))), ? || ':' || ? || ':' || b.id,
              b.id, g.id, ?, ?, b.revision + CASE WHEN ? = 'group_cancelled' THEN 1 ELSE 0 END,
              g.revision + 1, b.id, 'student', 'pending', ?, ?
       FROM bookings b JOIN groups g ON g.id = b.group_id
       WHERE g.id = ? AND b.status IN ('pending', 'confirmed')`,
    )
    .bind(operationId, eventType, eventType, templateId, eventType, createdAt, createdAt, groupId);
}

function rollingSlotReservation(
  db: D1Database,
  groupId: string,
  slotDate: string,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO rolling_schedule_slots (service_id, slot_date, group_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(THEORY_SERVICE_ID, slotDate, groupId, createdAt);
}

export async function commitSchedule(
  db: D1Database,
  rawCommand: ScheduleCommand,
  idempotencyKey: string,
  actorId: string,
  hmacSecret: string,
  now = new Date(),
): Promise<CommandOutcome<ScheduleCommitResult>> {
  const command = normalizeCommand(rawCommand);
  const digest = await commandDigest(hmacSecret, command);
  const replay = await findCommandReplay<ScheduleCommitResult>(db, idempotencyKey, "schedule.commit", digest, now);
  if (replay) return replay;
  const preview = await previewSchedule(db, command, now);
  const createdAt = timestamp(now);
  const scheduleGuardId = `${idempotencyKey}:schedule`;
  const statements: D1PreparedStatement[] = [
    revisionGuard(
      db,
      scheduleGuardId,
      command.expectedRevision,
      "SELECT revision FROM schedule_state WHERE service_id = ?",
      [THEORY_SERVICE_ID],
    ),
  ];
  const committedChanges: ScheduleChange[] = preview.changes.map((change) => ({ ...change }));

  if (command.action === "create" || command.action === "append") {
    const capacity = command.action === "create"
      ? command.capacity
      : (await db.prepare("SELECT capacity FROM groups WHERE id = ?").bind(command.lastGroupId).first<{ capacity: number }>())?.capacity;
    if (!capacity) throw new DomainError("last_group_changed", 409);
    committedChanges.forEach((change) => { change.id = crypto.randomUUID(); });
    for (const change of committedChanges) {
      const id = change.id!;
      statements.push(
        db.prepare(
          `INSERT INTO groups (
             id, service_id, sequence, start_date, start_time, starts_at_utc,
             date_status, enrollment_open, lifecycle, capacity, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, 'scheduled', ?, 1, ?, ?)`,
        ).bind(
          id,
          THEORY_SERVICE_ID,
          change.sequence,
          change.newDate,
          change.newTime,
          startsAtUtc(change.newDate!, change.newTime!),
          capacity,
          createdAt,
          createdAt,
        ),
        auditInsert(db, {
          entityType: "group",
          entityId: id,
          operationId: idempotencyKey,
          actorId,
          action: "created",
          newState: { startDate: change.newDate, startTime: change.newTime, dateStatus: "planned" },
          createdAt,
        }),
      );
    }
  } else if (command.action === "move") {
    const delta = dayDelta(preview.changes[0].oldDate!, preview.changes[0].newDate!);
    const ordered = [...preview.changes].sort((a, b) => delta >= 0 ? b.sequence - a.sequence : a.sequence - b.sequence);
    for (const change of ordered) {
      statements.push(
        rollingSlotReservation(db, change.id!, change.oldDate!, createdAt),
        groupNotificationInsert(db, idempotencyKey, change.id!, "group_moved", "student_group_moved", createdAt),
        db.prepare(
          `UPDATE groups
           SET start_date = ?, start_time = ?, starts_at_utc = ?, date_status = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        ).bind(
          change.newDate,
          change.newTime,
          startsAtUtc(change.newDate!, change.newTime!),
          change.newDateStatus,
          createdAt,
          change.id,
        ),
        auditInsert(db, {
          entityType: "group",
          entityId: change.id!,
          operationId: idempotencyKey,
          actorId,
          action: "moved",
          oldState: { startDate: change.oldDate, startTime: change.oldTime, dateStatus: change.oldDateStatus },
          newState: { startDate: change.newDate, startTime: change.newTime, dateStatus: change.newDateStatus },
          createdAt,
        }),
      );
    }
  } else {
    const change = preview.changes[0];
    statements.push(
      rollingSlotReservation(db, change.id!, change.oldDate!, createdAt),
      groupNotificationInsert(db, idempotencyKey, change.id!, "group_cancelled", "student_group_cancelled", createdAt),
      db.prepare(
        `INSERT INTO audit_events (
           id, entity_type, entity_id, operation_id, actor_id, action,
           old_state, new_state, created_at
         )
         SELECT lower(hex(randomblob(16))), 'booking', id, ?, ?, 'cancelled_by_group',
                json_object('status', status, 'groupId', group_id),
                json_object('status', 'cancelled', 'groupId', group_id), ?
         FROM bookings WHERE group_id = ? AND status IN ('pending', 'confirmed')`,
      ).bind(idempotencyKey, actorId, createdAt, change.id),
      db.prepare(
        `UPDATE bookings SET status = 'cancelled', revision = revision + 1,
             updated_at = ?, terminal_at = ?
         WHERE group_id = ? AND status IN ('pending', 'confirmed')`,
      ).bind(createdAt, createdAt, change.id),
      db.prepare(
        `UPDATE groups SET lifecycle = 'cancelled', enrollment_open = 0,
             cancelled_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      ).bind(createdAt, createdAt, change.id),
      auditInsert(db, {
        entityType: "group",
        entityId: change.id!,
        operationId: idempotencyKey,
        actorId,
        action: "cancelled",
        oldState: { lifecycle: "scheduled", startDate: change.oldDate },
        newState: { lifecycle: "cancelled", startDate: change.oldDate },
        createdAt,
      }),
    );
  }

  statements.push(
    db.prepare(
      "UPDATE schedule_state SET revision = revision + 1, updated_at = ? WHERE service_id = ?",
    ).bind(createdAt, THEORY_SERVICE_ID),
    deleteGuard(db, scheduleGuardId),
  );
  const result: ScheduleCommitResult = {
    scheduleRevision: command.expectedRevision + 1,
    changes: committedChanges,
    affectedBookings: preview.affectedBookings,
    notificationCount: preview.notificationCount,
  };
  try {
    return await executeCommand(db, {
      operationId: idempotencyKey,
      scope: "schedule.commit",
      payloadDigest: digest,
      resultCode: "committed",
      entityId: THEORY_SERVICE_ID,
      result,
      statements,
      now,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (await scheduleRevision(db, THEORY_SERVICE_ID) !== command.expectedRevision) {
      throw new DomainError("schedule_changed", 409);
    }
    const message = String(error);
    if (message.includes("idx_groups_scheduled_date") || message.includes("groups.service_id, groups.start_date")) {
      throw new DomainError("date_collision", 409);
    }
    if (message.includes("group_future_limit")) throw new DomainError("group_future_limit", 409);
    if (message.includes("group_must_be_future")) throw new DomainError("date_in_past", 409);
    throw new DomainError("schedule_conflict", 409);
  }
}

export async function patchGroup(
  db: D1Database,
  groupId: string,
  patch: GroupPatch,
  idempotencyKey: string,
  actorId: string,
  hmacSecret: string,
  now = new Date(),
): Promise<CommandOutcome<Group>> {
  if (!groupId) throw new DomainError("invalid_group", 400);
  integer(patch.expectedRevision, "invalid_revision", 1, Number.MAX_SAFE_INTEGER);
  integer(patch.expectedScheduleRevision, "invalid_revision", 1, Number.MAX_SAFE_INTEGER);
  if (patch.dateStatus !== undefined && patch.dateStatus !== "planned" && patch.dateStatus !== "confirmed") {
    throw new DomainError("invalid_date_status", 400);
  }
  if (patch.enrollmentOpen !== undefined && typeof patch.enrollmentOpen !== "boolean") {
    throw new DomainError("invalid_enrollment", 400);
  }
  if (patch.capacity !== undefined) integer(patch.capacity, "invalid_capacity", 1, 100);
  if (patch.dateStatus === undefined && patch.enrollmentOpen === undefined && patch.capacity === undefined) {
    throw new DomainError("empty_patch", 400);
  }
  const digestPayload = { groupId, ...patch };
  const digest = await commandDigest(hmacSecret, digestPayload);
  const replay = await findCommandReplay<Group>(db, idempotencyKey, "group.patch", digest, now);
  if (replay) return replay;
  const row = await db.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first<GroupRow>();
  if (!row) throw new DomainError("group_not_found", 404);
  const old = mapGroup(row);
  const updated: Group = {
    ...old,
    dateStatus: patch.dateStatus ?? old.dateStatus,
    enrollmentOpen: patch.enrollmentOpen ?? old.enrollmentOpen,
    capacity: patch.capacity ?? old.capacity,
    revision: old.revision + 1,
    updatedAt: timestamp(now),
  };
  const scheduleGuardId = `${idempotencyKey}:schedule`;
  const groupGuardId = `${idempotencyKey}:group`;
  const statements = [
    revisionGuard(db, scheduleGuardId, patch.expectedScheduleRevision, "SELECT revision FROM schedule_state WHERE service_id = ?", [row.service_id]),
    revisionGuard(db, groupGuardId, patch.expectedRevision, "SELECT revision FROM groups WHERE id = ? AND lifecycle = 'scheduled'", [groupId]),
    db.prepare(
      `UPDATE groups SET date_status = ?, enrollment_open = ?, capacity = ?,
         revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).bind(updated.dateStatus, updated.enrollmentOpen ? 1 : 0, updated.capacity, updated.updatedAt, groupId),
    auditInsert(db, {
      entityType: "group",
      entityId: groupId,
      operationId: idempotencyKey,
      actorId,
      action: "patched",
      oldState: { dateStatus: old.dateStatus, enrollmentOpen: old.enrollmentOpen, capacity: old.capacity },
      newState: { dateStatus: updated.dateStatus, enrollmentOpen: updated.enrollmentOpen, capacity: updated.capacity },
      createdAt: updated.updatedAt,
    }),
    db.prepare("UPDATE schedule_state SET revision = revision + 1, updated_at = ? WHERE service_id = ?")
      .bind(updated.updatedAt, row.service_id),
    deleteGuard(db, groupGuardId),
    deleteGuard(db, scheduleGuardId),
  ];
  try {
    return await executeCommand(db, {
      operationId: idempotencyKey,
      scope: "group.patch",
      payloadDigest: digest,
      resultCode: "updated",
      entityId: groupId,
      result: updated,
      statements,
      now,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (await scheduleRevision(db, row.service_id) !== patch.expectedScheduleRevision) {
      throw new DomainError("schedule_changed", 409);
    }
    const current = await db.prepare("SELECT revision FROM groups WHERE id = ?").bind(groupId).first<{ revision: number }>();
    if (!current || current.revision !== patch.expectedRevision) throw new DomainError("group_changed", 409);
    if (String(error).includes("group_capacity_below_confirmed")) {
      throw new DomainError("capacity_below_confirmed", 409);
    }
    throw new DomainError("group_conflict", 409);
  }
}

export const __groupInternals = { addDays, canonicalJson, startsAtUtc };
