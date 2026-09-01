import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const db = (env as any).DB as D1Database;

describe("schema", () => {
  it("создаёт все таблицы", async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%'")
      .all();
    const names = results.map((r: any) => r.name).sort();
    expect(names).toEqual(["conversations", "facts", "lead_events", "leads", "processed_updates"]);
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
});
