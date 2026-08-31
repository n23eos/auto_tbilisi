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
});
