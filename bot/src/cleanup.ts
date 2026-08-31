const UPDATES_KEEP_DAYS = 7;
const PHONE_RETENTION_DAYS = 90;

/**
 * Метка «телефона больше нет». Колонка phone — NOT NULL, поэтому вместо NULL
 * кладём текст: он же и читается человеком в карточке заявки.
 * Одна константа на запись и на защиту от повторной записи — чтобы литералы не разъехались.
 */
export const PHONE_ERASED = "удалён";

/** Ежедневная уборка по крону: мусор дедупа, брошенные анкеты, просроченные телефоны. */
export async function runCleanup(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM processed_updates WHERE seen_at < datetime('now', '-${UPDATES_KEEP_DAYS} days')`).run();
  await db.prepare("DELETE FROM conversations WHERE expires_at <= datetime('now')").run();
  // Телефон нужен только для связи: после закрытия храним 90 дней, потом затираем.
  // Условие phone != метка делает прогон идемпотентным — второй раз строки не трогаются
  // и updated_at (по нему же считается срок) не сдвигается.
  await db
    .prepare(
      `UPDATE leads SET phone = '${PHONE_ERASED}'
       WHERE status = 'closed' AND phone != '${PHONE_ERASED}'
         AND updated_at < datetime('now', '-${PHONE_RETENTION_DAYS} days')`,
    )
    .run();
}
