import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createLead,
  getLead,
  takeLead,
  markCalled,
  closeLead,
  releaseLead,
  renderLeadCard,
} from "../src/leads";

const db = (env as any).DB as D1Database;

async function makeLead(submissionId: string): Promise<number> {
  const { leadId } = await createLead(db, {
    submissionId,
    name: "Вася",
    phone: "+995599000001",
    question: "категория B",
    studentChatId: 555,
  });
  return leadId;
}

describe("createLead", () => {
  it("идемпотентен по submission_id", async () => {
    const a = await createLead(db, { submissionId: "s1", name: "А", phone: "+995599000002", question: null, studentChatId: 1 });
    const b = await createLead(db, { submissionId: "s1", name: "А", phone: "+995599000002", question: null, studentChatId: 1 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.leadId).toBe(a.leadId);
  });
});

describe("статусы", () => {
  it("взять может только один админ", async () => {
    const id = await makeLead("s2");
    expect(await takeLead(db, id, 10, "Нина")).toBe(true);
    expect(await takeLead(db, id, 20, "Олег")).toBe(false); // уже занята
    const lead = (await getLead(db, id))!;
    expect(lead.status).toBe("in_progress");
    expect(lead.assigned_to_name).toBe("Нина");
  });

  it("позвонил/закрыть — только назначенный", async () => {
    const id = await makeLead("s3");
    await takeLead(db, id, 10, "Нина");
    expect(await markCalled(db, id, 20)).toBe(false); // чужая заявка
    expect(await markCalled(db, id, 10)).toBe(true);
    expect(await markCalled(db, id, 10)).toBe(false); // повтор — идемпотентно
    expect(await closeLead(db, id, 20)).toBe(false);
    expect(await closeLead(db, id, 10)).toBe(true);
    expect((await getLead(db, id))!.status).toBe("closed");
  });

  it("освободить возвращает в new, другой может взять", async () => {
    const id = await makeLead("s4");
    await takeLead(db, id, 10, "Нина");
    expect(await releaseLead(db, id, 10)).toBe(true);
    const lead = (await getLead(db, id))!;
    expect(lead.status).toBe("new");
    expect(lead.assigned_to_id).toBeNull();
    expect(await takeLead(db, id, 20, "Олег")).toBe(true);
  });

  it("переходы пишутся в lead_events", async () => {
    const id = await makeLead("s5");
    await takeLead(db, id, 10, "Нина");
    await closeLead(db, id, 10);
    const { results } = await db
      .prepare("SELECT event FROM lead_events WHERE lead_id = ? ORDER BY id")
      .bind(id)
      .all();
    expect(results.map((r: any) => r.event)).toEqual(["created", "taken", "closed"]);
  });
});

describe("renderLeadCard", () => {
  it("новая заявка: телефон скрыт, кнопка «Взять»", async () => {
    const id = await makeLead("s6");
    const lead = (await getLead(db, id))!;
    const card = renderLeadCard(lead);
    expect(card.text).not.toContain("+995599000001");
    expect(card.keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(["✋ Взять в работу"]);
  });

  it("взятая: телефон виден, кнопки Позвонил/Закрыть/Освободить, имя админа", async () => {
    const id = await makeLead("s7");
    await takeLead(db, id, 10, "Нина");
    const card = renderLeadCard((await getLead(db, id))!);
    expect(card.text).toContain("+995599000001");
    expect(card.text).toContain("Нина");
    expect(card.keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual([
      "📞 Позвонил", "✅ Закрыть", "↩️ Освободить",
    ]);
  });

  it("экранирует HTML в данных ученика", async () => {
    const { leadId } = await createLead(db, {
      submissionId: "s8", name: "<b>X</b>", phone: "+995599000003", question: "a & b", studentChatId: 1,
    });
    const card = renderLeadCard((await getLead(db, leadId))!);
    expect(card.text).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(card.text).not.toContain("<b>X</b>");
  });
});
