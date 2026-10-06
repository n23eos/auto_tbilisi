import { THEORY_SERVICE_ID } from "./booking-types";
import {
  DomainError,
  auditInsert,
  commandDigest,
  deleteGuard,
  executeCommand,
  revisionGuard,
  timestamp,
} from "./booking-commands";

const INTERVAL_DAYS = 14;
const HORIZON = 3;
const DAY_MS = 86_400_000;

export interface RollingScheduleConfig {
  anchorDate: string;
  startTime: string;
  capacity: number;
  hmacSecret: string;
}

export interface RollingScheduleEnv {
  ROLLING_SCHEDULE_ENABLED?: string;
  ROLLING_SCHEDULE_ANCHOR_DATE?: string;
  ROLLING_SCHEDULE_START_TIME?: string;
  ROLLING_SCHEDULE_CAPACITY?: string;
  BOOKING_SECRET?: string;
}

export interface RollingScheduleResult {
  changed: boolean;
  replayed: boolean;
  scheduleRevision: number;
  createdGroupIds: string[];
  reservedSlots: Array<{ slotDate: string; groupId: string }>;
}

interface GroupRow {
  id: string;
  sequence: number;
  start_date: string;
  starts_at_utc: string;
  lifecycle: "scheduled" | "cancelled" | "completed";
}

interface SlotRow {
  slot_date: string;
  group_id: string | null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function startsAtUtc(date: string, time: string): string {
  return new Date(`${date}T${time}:00+04:00`).toISOString().replace(".000Z", "Z");
}

function alignedWithAnchor(date: string, anchorDate: string): boolean {
  const delta = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / DAY_MS;
  return Number.isInteger(delta) && delta >= 0 && delta % INTERVAL_DAYS === 0;
}

export function rollingScheduleConfig(env: RollingScheduleEnv): RollingScheduleConfig | null {
  if (env.ROLLING_SCHEDULE_ENABLED === undefined || env.ROLLING_SCHEDULE_ENABLED === "false") return null;
  if (env.ROLLING_SCHEDULE_ENABLED !== "true") throw new Error("rolling_schedule_invalid_enabled");
  if (!env.BOOKING_SECRET || env.BOOKING_SECRET.length < 32) {
    throw new Error("rolling_schedule_secret_missing");
  }
  const anchorDate = env.ROLLING_SCHEDULE_ANCHOR_DATE ?? "2026-10-05";
  const startTime = env.ROLLING_SCHEDULE_START_TIME ?? "19:00";
  const capacityText = env.ROLLING_SCHEDULE_CAPACITY ?? "12";
  const capacity = Number(capacityText);
  if (!validDate(anchorDate)) throw new Error("rolling_schedule_invalid_anchor");
  if (!validTime(startTime)) throw new Error("rolling_schedule_invalid_time");
  if (!/^\d+$/.test(capacityText) || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
    throw new Error("rolling_schedule_invalid_capacity");
  }
  return { anchorDate, startTime, capacity, hmacSecret: env.BOOKING_SECRET };
}

export function rollingScheduleDates(
  now: Date,
  config: Pick<RollingScheduleConfig, "anchorDate" | "startTime">,
  count: number,
): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("rolling_schedule_invalid_count");
  const anchorStart = Date.parse(startsAtUtc(config.anchorDate, config.startTime));
  let index = Math.max(0, Math.floor((now.getTime() - anchorStart) / (INTERVAL_DAYS * DAY_MS)));
  while (Date.parse(startsAtUtc(addDays(config.anchorDate, index * INTERVAL_DAYS), config.startTime)) <= now.getTime()) {
    index += 1;
  }
  return Array.from({ length: count }, (_, offset) => addDays(
    config.anchorDate,
    (index + offset) * INTERVAL_DAYS,
  ));
}

function chooseGroup(rows: GroupRow[]): GroupRow {
  return [...rows].sort((left, right) => {
    if (left.lifecycle === "scheduled" && right.lifecycle !== "scheduled") return -1;
    if (right.lifecycle === "scheduled" && left.lifecycle !== "scheduled") return 1;
    return left.sequence - right.sequence;
  })[0];
}

export async function maintainRollingSchedule(
  db: D1Database,
  config: RollingScheduleConfig,
  now = new Date(),
): Promise<RollingScheduleResult> {
  const [stateResult, groupsResult, slotsResult] = await db.batch([
    db.prepare("SELECT revision FROM schedule_state WHERE service_id = ?").bind(THEORY_SERVICE_ID),
    db.prepare(
      "SELECT id, sequence, start_date, starts_at_utc, lifecycle FROM groups WHERE service_id = ? ORDER BY sequence",
    ).bind(THEORY_SERVICE_ID),
    db.prepare(
      "SELECT slot_date, group_id FROM rolling_schedule_slots WHERE service_id = ? ORDER BY slot_date",
    ).bind(THEORY_SERVICE_ID),
  ]);
  const state = stateResult.results[0] as { revision: number } | undefined;
  if (!state) throw new DomainError("schedule_unavailable", 503);
  const groups = groupsResult.results as unknown as GroupRow[];
  const slots = slotsResult.results as unknown as SlotRow[];
  const slotDates = new Set(slots.map((slot) => slot.slot_date));
  const slottedGroupIds = new Set(slots.flatMap((slot) => slot.group_id ? [slot.group_id] : []));
  const rowsByDate = new Map<string, GroupRow[]>();
  for (const group of groups) {
    const rows = rowsByDate.get(group.start_date) ?? [];
    rows.push(group);
    rowsByDate.set(group.start_date, rows);
  }

  const reservedSlots: Array<{ slotDate: string; groupId: string }> = [];
  for (const [date, rows] of [...rowsByDate].sort(([left], [right]) => left.localeCompare(right))) {
    if (Date.parse(startsAtUtc(date, config.startTime)) <= now.getTime()) continue;
    if (!alignedWithAnchor(date, config.anchorDate) || slotDates.has(date)) continue;
    const group = chooseGroup(rows.filter((row) => !slottedGroupIds.has(row.id)));
    if (!group) continue;
    reservedSlots.push({ slotDate: date, groupId: group.id });
    slotDates.add(date);
    slottedGroupIds.add(group.id);
  }

  const futureCount = groups.filter(
    (group) => group.lifecycle === "scheduled" && Date.parse(group.starts_at_utc) > now.getTime(),
  ).length;
  const createCount = Math.max(0, HORIZON - futureCount);
  const datesToCreate: string[] = [];
  const scanLimit = slotDates.size + rowsByDate.size + HORIZON;
  for (const date of rollingScheduleDates(now, config, scanLimit)) {
    if (datesToCreate.length >= createCount) break;
    if (slotDates.has(date)) continue;
    const existing = rowsByDate.get(date);
    if (existing?.length) {
      const group = chooseGroup(existing.filter((row) => !slottedGroupIds.has(row.id)));
      if (group) {
        reservedSlots.push({ slotDate: date, groupId: group.id });
        slotDates.add(date);
        slottedGroupIds.add(group.id);
      }
      continue;
    }
    datesToCreate.push(date);
    slotDates.add(date);
  }

  if (reservedSlots.length === 0 && datesToCreate.length === 0) {
    return {
      changed: false,
      replayed: false,
      scheduleRevision: state.revision,
      createdGroupIds: [],
      reservedSlots: [],
    };
  }

  const plan = {
    expectedRevision: state.revision,
    anchorDate: config.anchorDate,
    startTime: config.startTime,
    capacity: config.capacity,
    reservedSlots,
    datesToCreate,
  };
  const digest = await commandDigest(config.hmacSecret, plan);
  const operationId = `rolling-schedule:${digest.slice(0, 48)}`;
  const createdAt = timestamp(now);
  const scheduleGuardId = `${operationId}:schedule`;
  const statements: D1PreparedStatement[] = [
    revisionGuard(
      db,
      scheduleGuardId,
      state.revision,
      "SELECT revision FROM schedule_state WHERE service_id = ?",
      [THEORY_SERVICE_ID],
    ),
  ];

  for (const slot of reservedSlots) {
    statements.push(
      db.prepare(
        `INSERT INTO rolling_schedule_slots (service_id, slot_date, group_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(THEORY_SERVICE_ID, slot.slotDate, slot.groupId, createdAt),
      auditInsert(db, {
        entityType: "schedule",
        entityId: THEORY_SERVICE_ID,
        operationId,
        actorId: "system:rolling-schedule",
        action: "rolling_slot_reserved",
        newState: { slotDate: slot.slotDate, groupId: slot.groupId },
        createdAt,
      }),
    );
  }

  const firstSequence = groups.reduce((max, group) => Math.max(max, group.sequence), 0) + 1;
  const createdGroupIds = datesToCreate.map(() => crypto.randomUUID());
  datesToCreate.forEach((date, index) => {
    const groupId = createdGroupIds[index];
    statements.push(
      db.prepare(
        `INSERT INTO groups (
           id, service_id, sequence, start_date, start_time, starts_at_utc,
           date_status, enrollment_open, lifecycle, capacity, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, 'scheduled', ?, 1, ?, ?)`,
      ).bind(
        groupId,
        THEORY_SERVICE_ID,
        firstSequence + index,
        date,
        config.startTime,
        startsAtUtc(date, config.startTime),
        config.capacity,
        createdAt,
        createdAt,
      ),
      db.prepare(
        `INSERT INTO rolling_schedule_slots (service_id, slot_date, group_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(THEORY_SERVICE_ID, date, groupId, createdAt),
      auditInsert(db, {
        entityType: "group",
        entityId: groupId,
        operationId,
        actorId: "system:rolling-schedule",
        action: "created_automatically",
        newState: {
          startDate: date,
          startTime: config.startTime,
          dateStatus: "planned",
          capacity: config.capacity,
          slotDate: date,
        },
        createdAt,
      }),
    );
  });

  statements.push(
    db.prepare("UPDATE schedule_state SET revision = revision + 1, updated_at = ? WHERE service_id = ?")
      .bind(createdAt, THEORY_SERVICE_ID),
    deleteGuard(db, scheduleGuardId),
  );
  const result: RollingScheduleResult = {
    changed: true,
    replayed: false,
    scheduleRevision: state.revision + 1,
    createdGroupIds,
    reservedSlots: [
      ...reservedSlots,
      ...datesToCreate.map((slotDate, index) => ({ slotDate, groupId: createdGroupIds[index] })),
    ],
  };
  try {
    const outcome = await executeCommand(db, {
      operationId,
      scope: "schedule.rolling-maintain",
      payloadDigest: digest,
      resultCode: "maintained",
      entityId: THEORY_SERVICE_ID,
      result,
      statements,
      now,
    });
    return { ...outcome.result, replayed: outcome.replayed };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const current = await db.prepare("SELECT revision FROM schedule_state WHERE service_id = ?")
      .bind(THEORY_SERVICE_ID).first<{ revision: number }>();
    if (!current || current.revision !== state.revision) throw new DomainError("schedule_changed", 409);
    const message = String(error);
    if (message.includes("group_future_limit")) throw new DomainError("group_future_limit", 409);
    if (message.includes("group_must_be_future")) throw new DomainError("date_in_past", 409);
    if (message.includes("rolling_schedule_slots") || message.includes("groups.start_date")) {
      throw new DomainError("schedule_changed", 409);
    }
    throw new DomainError("schedule_conflict", 409);
  }
}
