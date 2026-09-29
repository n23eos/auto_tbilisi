import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const db = (env as any).DB as D1Database;

describe("schema", () => {
  it("создаёт все таблицы", async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%'")
      .all();
    const names = results.map((r: any) => r.name).sort();
    expect(names).toEqual([
      "audit_events",
      "booking_rate_limits",
      "bookings",
      "chat_leases",
      "command_guards",
      "command_results",
      "conversations",
      "facts",
      "groups",
      "inbox",
      "lead_events",
      "leads",
      "outbox",
      "processed_updates",
      "schedule_state",
    ]);
  });

  it("submission_id уникален", async () => {
    const ins = "INSERT INTO leads (submission_id, name, phone, student_chat_id) VALUES (?, 'A', '+995599000000', 1)";
    await db.prepare(ins).bind("dup-1").run();
    await expect(db.prepare(ins).bind("dup-1").run()).rejects.toThrow();
  });

  it("индексы по leads на месте", async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='leads' AND name NOT LIKE 'sqlite_%'")
      .all();
    const names = results.map((r: any) => r.name).sort();
    expect(names).toEqual(["idx_leads_delivery", "idx_leads_status"]);
  });

  it("leads.status принимает только известные значения", async () => {
    const ins = "INSERT INTO leads (submission_id, name, phone, student_chat_id, status) VALUES (?, 'A', '+995599000000', 1, ?)";
    for (const status of ["new", "in_progress", "contacted", "closed"]) {
      await db.prepare(ins).bind(`status-ok-${status}`, status).run();
    }
    await expect(db.prepare(ins).bind("status-bad", "cancelled").run()).rejects.toThrow();
  });

  it("leads.delivery_status принимает только известные значения", async () => {
    const ins =
      "INSERT INTO leads (submission_id, name, phone, student_chat_id, delivery_status) VALUES (?, 'A', '+995599000000', 1, ?)";
    for (const delivery of ["pending", "delivered"]) {
      await db.prepare(ins).bind(`delivery-ok-${delivery}`, delivery).run();
    }
    await expect(db.prepare(ins).bind("delivery-bad", "sent").run()).rejects.toThrow();
  });

  it("UPDATE тоже не может выставить неизвестный статус", async () => {
    await db
      .prepare("INSERT INTO leads (submission_id, name, phone, student_chat_id) VALUES ('status-update', 'A', '+995599000000', 1)")
      .run();
    await expect(
      db.prepare("UPDATE leads SET status = 'archived' WHERE submission_id = 'status-update'").run(),
    ).rejects.toThrow();
  });

  it("guard через VALUES откатывает следующие записи при mismatch и NULL", async () => {
    const mismatch = db.prepare(
      `INSERT INTO command_guards (operation_id, expected_revision, actual_revision)
       VALUES ('guard-mismatch', 2, (SELECT revision FROM schedule_state WHERE service_id = 'theory_group'))`,
    );
    await expect(db.batch([
      mismatch,
      db.prepare("INSERT INTO facts (key, value) VALUES ('must-rollback', '1')"),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT 1 FROM facts WHERE key = 'must-rollback'").first()).toBeNull();

    const missing = db.prepare(
      `INSERT INTO command_guards (operation_id, expected_revision, actual_revision)
       VALUES ('guard-null', 1, (SELECT revision FROM schedule_state WHERE service_id = 'missing'))`,
    );
    await expect(db.batch([
      missing,
      db.prepare("INSERT INTO facts (key, value) VALUES ('must-also-rollback', '1')"),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT 1 FROM facts WHERE key = 'must-also-rollback'").first()).toBeNull();
  });

  it("ограничивает горизонт тремя будущими группами", async () => {
    const insert = (id: string, sequence: number, date: string) => db.prepare(
      `INSERT INTO groups (
         id, service_id, sequence, start_date, start_time, starts_at_utc,
         created_at, updated_at
       ) VALUES (?, 'theory_group', ?, ?, '19:00', ?, ?, ?)`,
    ).bind(id, sequence, date, `${date}T15:00:00Z`, "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
    await db.batch([
      insert("g-1", 1, "2030-02-01"),
      insert("g-2", 2, "2030-02-15"),
      insert("g-3", 3, "2030-03-01"),
    ]);
    await expect(insert("g-4", 4, "2030-03-15").run()).rejects.toThrow(/group_future_limit/);
  });

  it("не позволяет уменьшить capacity ниже подтверждённых", async () => {
    await db.prepare(
      `INSERT INTO groups (
         id, service_id, sequence, start_date, start_time, starts_at_utc, capacity,
         created_at, updated_at
       ) VALUES ('capacity-group', 'theory_group', 1, '2030-04-01', '19:00',
                 '2030-04-01T15:00:00Z', 2, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
    ).run();
    await db.prepare(
      `INSERT INTO bookings (
         id, public_reference, group_id, name, phone, source, status, revision,
         consent_version, consent_at, created_at, updated_at
       ) VALUES ('confirmed-booking', 'BK-SCHEMA000001', 'capacity-group', 'A', '+995599000001',
                 'site_form', 'confirmed', 1, 'v1', '2030-01-01T00:00:00.000Z',
                 '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
    ).run();
    await db.prepare(
      `INSERT INTO bookings (
         id, public_reference, group_id, name, phone, source, status, revision,
         consent_version, consent_at, created_at, updated_at
       ) VALUES ('confirmed-booking-2', 'BK-SCHEMA000002', 'capacity-group', 'B', '+995599000002',
                 'site_form', 'confirmed', 1, 'v1', '2030-01-01T00:00:00.000Z',
                 '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
    ).run();
    await expect(db.prepare("UPDATE groups SET capacity = 1 WHERE id = 'capacity-group'").run()).rejects.toThrow(/group_capacity_below_confirmed/);
    await expect(db.prepare("UPDATE groups SET capacity = 2 WHERE id = 'capacity-group'").run()).resolves.toBeTruthy();
  });
});
