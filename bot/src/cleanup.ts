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
const BOOKING_TERMINAL_PII_DAYS = 90;
const BOOKING_MAX_PII_DAYS = 180;
const AUDIT_KEEP_DAYS = 180;
const OUTBOX_TERMINAL_DAYS = 30;
const OUTBOX_MAX_DAYS = 180;

/**
 * Метка «телефона больше нет». Колонка phone — NOT NULL, поэтому вместо NULL
 * кладём текст: он же и читается человеком в карточке заявки.
 * Одна константа на запись и на защиту от повторной записи — чтобы литералы не разъехались.
 */
export const PHONE_ERASED = "удалён";

/** Ежедневная уборка по крону: мусор дедупа, брошенные анкеты, просроченные телефоны и журнал. */
export async function runCleanup(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM processed_updates WHERE seen_at < datetime('now', '-${UPDATES_KEEP_DAYS} days')`).run();
  // Сначала закрываем сообщения анкеты. Иначе ON DELETE SET NULL оставит
  // сиротскую запись, которую обработчик уже не признает устаревшей по revision.
  await db
    .prepare(
      `UPDATE outbox
       SET state = 'superseded', revision = revision + 1,
           terminal_at = COALESCE(terminal_at, datetime('now')),
           lease_until = NULL, lease_token = NULL,
           last_error_code = 'conversation_expired', updated_at = datetime('now')
       WHERE event_type = 'conversation_prompt'
         AND state IN ('pending', 'sending')
         AND EXISTS (
           SELECT 1 FROM conversations c
           WHERE c.id = outbox.conversation_id AND julianday(c.expires_at) <= julianday('now')
         )`,
    )
    .run();
  await db.prepare("DELETE FROM conversations WHERE julianday(expires_at) <= julianday('now')").run();

  // Исходное событие Telegram живет максимум сутки. Маркер update_id остается
  // до семи дней, чтобы поздний повтор не запустил событие заново.
  await db
    .prepare(
      `UPDATE inbox
       SET payload = NULL, chat_id = NULL,
           state = CASE WHEN state = 'done' THEN 'done' ELSE 'failed' END,
           retry_at = NULL, lease_until = NULL, lease_token = NULL,
           last_error_code = CASE WHEN state = 'done' THEN last_error_code ELSE 'payload_expired' END,
           updated_at = datetime('now')
       WHERE payload IS NOT NULL AND julianday(payload_expires_at) <= julianday('now')`,
    )
    .run();
  await db.prepare("DELETE FROM inbox WHERE julianday(expires_at) <= julianday('now')").run();
  await db.prepare("DELETE FROM command_results WHERE julianday(expires_at) <= julianday('now')").run();
  await db.prepare("DELETE FROM audit_events WHERE julianday(created_at) < julianday('now', '-180 days')").run();
  await db.prepare("DELETE FROM booking_rate_limits WHERE julianday(expires_at) <= julianday('now')").run();
  await db.prepare(`DELETE FROM lead_events WHERE created_at < datetime('now', '-${EVENTS_KEEP_DAYS} days')`).run();
  // Контактные данные нужны только для связи: после закрытия храним 90 дней,
  // а в любом случае — не дольше 180 дней с создания заявки, даже если её не
  // закрыли. Условие phone != метка делает прогон идемпотентным — второй раз
  // строки не трогаются и updated_at (по нему же считается срок) не сдвигается.
  //
  // Затирается не только телефон. Имя, свободный текст вопроса и
  // student_chat_id вместе так же однозначно указывают на человека, а chat_id
  // ещё и позволяет ему написать — то есть строка остаётся полноценной
  // карточкой живого человека, и обещание «храним 90 дней» не выполняется.
  // Сама строка остаётся: на её id ссылается lead_events, и по ней же
  // считается статистика заявок.
  await db
    .prepare(
      `UPDATE leads SET phone = '${PHONE_ERASED}', name = '${PHONE_ERASED}',
                        question = NULL, student_chat_id = 0
       WHERE phone != '${PHONE_ERASED}'
         AND (
           (status = 'closed' AND updated_at < datetime('now', '-${PHONE_RETENTION_DAYS} days'))
           OR created_at < datetime('now', '-${PHONE_MAX_AGE_DAYS} days')
         )`,
    )
    .run();

  await db
    .prepare(
      `UPDATE bookings
       SET name = NULL, phone = NULL, student_chat_id = NULL,
           pii_erased_at = COALESCE(pii_erased_at, datetime('now')),
           updated_at = datetime('now')
       WHERE pii_erased_at IS NULL
         AND (
           julianday(created_at) < julianday('now', '-${BOOKING_MAX_PII_DAYS} days')
           OR (
             terminal_at IS NOT NULL
             AND julianday(terminal_at) < julianday('now', '-${BOOKING_TERMINAL_PII_DAYS} days')
           )
         )`,
    )
    .run();

  // После удаления контакта отправка ученику прекращается. Ручная задача
  // закрывается с явной причиной, остальные старые отправки отменяются.
  await db
    .prepare(
      `UPDATE outbox
       SET state = CASE WHEN state = 'manual_contact' THEN 'resolved' ELSE 'superseded' END,
           revision = revision + 1,
           resolved_at = CASE WHEN state = 'manual_contact' THEN datetime('now') ELSE resolved_at END,
           resolved_by_actor = CASE WHEN state = 'manual_contact' THEN 'cleanup' ELSE resolved_by_actor END,
           terminal_at = COALESCE(terminal_at, datetime('now')),
           lease_until = NULL, lease_token = NULL,
           last_error_code = 'contact_expired', updated_at = datetime('now')
       WHERE recipient_role = 'student'
         AND state IN ('pending', 'sending', 'manual_contact')
         AND EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.id = outbox.booking_id AND b.pii_erased_at IS NOT NULL
         )`,
    )
    .run();

  await db
    .prepare(
      `DELETE FROM outbox
       WHERE (state = 'resolved' AND resolved_at IS NOT NULL
              AND julianday(resolved_at) < julianday('now', '-${OUTBOX_TERMINAL_DAYS} days'))
          OR (state IN ('sent', 'failed', 'superseded') AND terminal_at IS NOT NULL
              AND julianday(terminal_at) < julianday('now', '-${OUTBOX_TERMINAL_DAYS} days'))
          OR julianday(created_at) < julianday('now', '-${OUTBOX_MAX_DAYS} days')`,
    )
    .run();
}
