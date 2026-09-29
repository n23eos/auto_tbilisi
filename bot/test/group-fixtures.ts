import { createBooking } from "../src/bookings";
import { __groupInternals } from "../src/groups";
import type { BookingSource, GroupDateStatus } from "../src/booking-types";

export const TEST_SECRET = "test-command-hmac-secret";
export const TEST_NOW = new Date("2030-01-01T08:00:00.000Z");

export function operationId(label: string): string {
  return `test:${label}:${crypto.randomUUID()}`.slice(0, 128);
}

export async function insertGroup(
  db: D1Database,
  input: {
    id?: string;
    sequence: number;
    startDate: string;
    startTime?: string;
    capacity?: number;
    revision?: number;
    dateStatus?: GroupDateStatus;
    enrollmentOpen?: boolean;
  },
): Promise<string> {
  const id = input.id ?? crypto.randomUUID();
  const now = TEST_NOW.toISOString();
  await db
    .prepare(
      `INSERT INTO groups (
         id, service_id, sequence, start_date, start_time, starts_at_utc,
         date_status, enrollment_open, lifecycle, capacity, revision,
         created_at, updated_at
       ) VALUES (?, 'theory_group', ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.sequence,
      input.startDate,
      input.startTime ?? "19:00",
      __groupInternals.startsAtUtc(input.startDate, input.startTime ?? "19:00"),
      input.dateStatus ?? "planned",
      input.enrollmentOpen === false ? 0 : 1,
      input.capacity ?? 12,
      input.revision ?? 1,
      now,
      now,
    )
    .run();
  return id;
}

export async function insertBooking(
  db: D1Database,
  input: {
    groupId: string;
    groupRevision?: number;
    name?: string;
    phone?: string;
    source?: Exclude<BookingSource, "legacy">;
    studentChatId?: number;
  },
) {
  return createBooking(
    db,
    {
      groupId: input.groupId,
      groupRevision: input.groupRevision ?? 1,
      name: input.name ?? "Тестовый ученик",
      phone: input.phone ?? "+995599000001",
      consentVersion: "test-v1",
      source: input.source ?? "site_form",
      ...(input.studentChatId === undefined ? {} : { studentChatId: input.studentChatId }),
    },
    operationId("booking"),
    TEST_SECRET,
    TEST_NOW,
  );
}
