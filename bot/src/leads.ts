import { escapeHtml, escapeClamped } from "./escape";
import { formatTbilisi } from "./time";
import type { InlineKeyboard } from "./telegram";
import type { Lead } from "./types";

export async function createLead(
  db: D1Database,
  input: { submissionId: string; name: string; phone: string; question: string | null; studentChatId: number },
): Promise<{ created: boolean; leadId: number }> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO leads (submission_id, name, phone, question, student_chat_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.submissionId, input.name, input.phone, input.question, input.studentChatId)
    .run();
  const row = await db
    .prepare("SELECT id FROM leads WHERE submission_id = ?")
    .bind(input.submissionId)
    .first<{ id: number }>();
  const created = inserted.meta.changes > 0;
  if (created) await logEvent(db, row!.id, "created", null);
  return { created, leadId: row!.id };
}

export async function getLead(db: D1Database, id: number): Promise<Lead | null> {
  return db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<Lead>();
}

async function logEvent(db: D1Database, leadId: number, event: string, actorId: number | null): Promise<void> {
  await db
    .prepare("INSERT INTO lead_events (lead_id, event, actor_id) VALUES (?, ?, ?)")
    .bind(leadId, event, actorId)
    .run();
}

/** Условный UPDATE: успех — по числу изменённых строк. Даёт и атомарность, и идемпотентность. */
async function transition(
  db: D1Database,
  sql: string,
  binds: unknown[],
  leadId: number,
  event: string,
  actorId: number,
): Promise<boolean> {
  const res = await db.prepare(sql).bind(...binds).run();
  const ok = res.meta.changes > 0;
  if (ok) await logEvent(db, leadId, event, actorId);
  return ok;
}

export function takeLead(db: D1Database, leadId: number, adminId: number, adminName: string): Promise<boolean> {
  return transition(
    db,
    `UPDATE leads SET status = 'in_progress', assigned_to_id = ?, assigned_to_name = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'new'`,
    [adminId, adminName, leadId],
    leadId, "taken", adminId,
  );
}

export function markCalled(db: D1Database, leadId: number, adminId: number): Promise<boolean> {
  return transition(
    db,
    `UPDATE leads SET status = 'contacted', updated_at = datetime('now')
     WHERE id = ? AND status = 'in_progress' AND assigned_to_id = ?`,
    [leadId, adminId],
    leadId, "called", adminId,
  );
}

export function closeLead(db: D1Database, leadId: number, adminId: number): Promise<boolean> {
  return transition(
    db,
    `UPDATE leads SET status = 'closed', updated_at = datetime('now')
     WHERE id = ? AND status IN ('in_progress', 'contacted') AND assigned_to_id = ?`,
    [leadId, adminId],
    leadId, "closed", adminId,
  );
}

export function releaseLead(db: D1Database, leadId: number, adminId: number): Promise<boolean> {
  return transition(
    db,
    `UPDATE leads SET status = 'new', assigned_to_id = NULL, assigned_to_name = NULL, updated_at = datetime('now')
     WHERE id = ? AND status IN ('in_progress', 'contacted') AND assigned_to_id = ?`,
    [leadId, adminId],
    leadId, "released", adminId,
  );
}

/**
 * Снятие исполнителя администратором — БЕЗ проверки, что он и есть исполнитель.
 * Отдельная функция, а не послабление в releaseLead: тот остаётся
 * самообслуживанием («освобождаю свою заявку») и обязан требовать совпадения
 * assigned_to_id, иначе кнопка «Освободить» начнёт снимать чужие заявки.
 * Здесь же весь смысл в обратном: админа, взявшего заявку, могло уже не быть
 * в школе. Условие по статусу остаётся: закрытую заявку не переоткрываем,
 * а на свободной снимать нечего — оба случая вернут false.
 */
export function forceReleaseLead(db: D1Database, leadId: number, adminId: number): Promise<boolean> {
  return transition(
    db,
    `UPDATE leads SET status = 'new', assigned_to_id = NULL, assigned_to_name = NULL, updated_at = datetime('now')
     WHERE id = ? AND status IN ('in_progress', 'contacted')`,
    [leadId],
    leadId, "force_released", adminId,
  );
}

const STATUS_LABEL: Record<string, string> = {
  new: "🆕 Новая",
  in_progress: "✋ В работе",
  contacted: "📞 Созвонились",
  closed: "✅ Закрыта",
};

/** Человеческое название статуса для сообщений админу; неизвестный — как есть, а не «undefined». */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

// Потолки на длину полей уже В КАРТОЧКЕ, считая экранирование. Ввод ученика
// режется ещё в анкете, но строка могла попасть в базу раньше этой проверки
// или из другого места — а недоставленная карточка означает потерянную заявку,
// поэтому рендер обязан влезать в лимит Telegram при любых данных.
// Сумма потолков (200 + 2000 + 300) с запасом меньше 4096.
const CARD_NAME_LIMIT = 200;
const CARD_QUESTION_LIMIT = 2000;
const CARD_ADMIN_NAME_LIMIT = 300;

export function renderLeadCard(lead: Lead): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    // statusLabel(), а не STATUS_LABEL напрямую: у leads.status нет CHECK в схеме,
    // и неизвестное значение отрисовалось бы как «Заявка #7 · undefined».
    `<b>Заявка #${lead.id}</b> · ${statusLabel(lead.status)}`,
    `Имя: ${escapeClamped(lead.name, CARD_NAME_LIMIT)}`,
  ];
  // Телефон показываем только после взятия — чтобы не звонили двое сразу
  if (lead.status !== "new") lines.push(`Телефон: ${escapeHtml(lead.phone)}`);
  if (lead.question) lines.push(`Вопрос: ${escapeClamped(lead.question, CARD_QUESTION_LIMIT)}`);
  if (lead.assigned_to_name) lines.push(`Ведёт: ${escapeClamped(lead.assigned_to_name, CARD_ADMIN_NAME_LIMIT)}`);
  lines.push(`Создана: ${formatTbilisi(lead.created_at)} (Тбилиси)`);

  const rows: InlineKeyboard["inline_keyboard"] = [];
  if (lead.status === "new") {
    rows.push([{ text: "✋ Взять в работу", callback_data: `lead:take:${lead.id}` }]);
  } else if (lead.status === "in_progress") {
    rows.push([
      { text: "📞 Позвонил", callback_data: `lead:called:${lead.id}` },
      { text: "✅ Закрыть", callback_data: `lead:close:${lead.id}` },
      { text: "↩️ Освободить", callback_data: `lead:release:${lead.id}` },
    ]);
  } else if (lead.status === "contacted") {
    rows.push([
      { text: "✅ Закрыть", callback_data: `lead:close:${lead.id}` },
      { text: "↩️ Освободить", callback_data: `lead:release:${lead.id}` },
    ]);
  }
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}
