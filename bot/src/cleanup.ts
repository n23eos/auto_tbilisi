const UPDATES_KEEP_DAYS = 7;
const PHONE_RETENTION_DAYS = 90;
// Потолок хранения независимо от статуса. Заявку могут не закрыть никогда
// (спам-запись, ученик не отвечает, админ забыл нажать «Закрыть») — и тогда
// правило «90 дней после закрытия» не срабатывает вообще, а телефон лежит
// вечно. Отсчёт от создания заявки, а не от updated_at: иначе любое действие
// админа сдвигало бы срок.
const PHONE_MAX_AGE_DAYS = 180;
// Журнал действий по заявке нигде не читается кодом — он для разбора спорных
// случаев «кто взял заявку и что с ней стало». Тот же срок, что и потолок
// хранения телефона: после него у заявки уже нет контактных данных, и
// разбирать по журналу нечего.
const EVENTS_KEEP_DAYS = 180;

/**
 * Метка «телефона больше нет». Колонка phone — NOT NULL, поэтому вместо NULL
 * кладём текст: он же и читается человеком в карточке заявки.
 * Одна константа на запись и на защиту от повторной записи — чтобы литералы не разъехались.
 */
export const PHONE_ERASED = "удалён";

/** Ежедневная уборка по крону: мусор дедупа, брошенные анкеты, просроченные телефоны и журнал. */
export async function runCleanup(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM processed_updates WHERE seen_at < datetime('now', '-${UPDATES_KEEP_DAYS} days')`).run();
  await db.prepare("DELETE FROM conversations WHERE expires_at <= datetime('now')").run();
  await db.prepare(`DELETE FROM lead_events WHERE created_at < datetime('now', '-${EVENTS_KEEP_DAYS} days')`).run();
  // Телефон нужен только для связи: после закрытия храним 90 дней, а в любом
  // случае — не дольше 180 дней с создания заявки, даже если её не закрыли.
  // Условие phone != метка делает прогон идемпотентным — второй раз строки не трогаются
  // и updated_at (по нему же считается срок) не сдвигается.
  await db
    .prepare(
      `UPDATE leads SET phone = '${PHONE_ERASED}'
       WHERE phone != '${PHONE_ERASED}'
         AND (
           (status = 'closed' AND updated_at < datetime('now', '-${PHONE_RETENTION_DAYS} days'))
           OR created_at < datetime('now', '-${PHONE_MAX_AGE_DAYS} days')
         )`,
    )
    .run();
}
