# Модель данных

Все новые таблицы в существующей D1. Поля ниже обязательны, если явно не указано nullable. Схема реализуется миграциями. UUID генерируются сервером; пользователь не назначает group_id новой группе. SQL foreign keys включены. SQLite-каталог цен не меняется.

## groups и schedule_state

- groups.id: UUID, immutable primary key.
- service_id: `theory_group` в v1.
- sequence: положительное целое, unique(service_id, sequence), immutable; порядок переноса.
- start_date: реальная календарная дата YYYY-MM-DD; start_time: HH:MM; timezone: Asia/Tbilisi. Согласованное starts_at_utc вычисляется сервером.
- date_status: `planned|confirmed`; enrollment_open: boolean; lifecycle: `scheduled|cancelled|completed`.
- capacity: целое 1..100, default 12, никогда меньше числа confirmed.
- revision: целое >=1; created_at/updated_at: UTC.
- cancelled_at/completed_at: nullable UTC.
- schedule_state: PK service_id, revision>=1, updated_at UTC. Общая ревизия изменяется при любом изменении группы; booking revision независима.

Ограничения: максимум три scheduled с starts_at_utc > now на service_id, независимо от enrollment_open/date_status. В одном service_id две scheduled группы не имеют одну start_date. Чтение автоматически фильтрует прошедшие по времени, даже если cron не изменил lifecycle. Уникальность, лимит и порядок проверяются внутри общей транзакции. Создание только в будущем.

Перенос сохраняет id/sequence, меняет дату/revision. Следующие предварительные сдвигаются на delta в календарных днях. Наличие следующей confirmed блокирует каскад целиком. Перенос выбранной confirmed допускается отдельным явным согласием и сбрасывает ее date_status в planned; повторное подтверждение старта отдельной кнопкой. Нельзя автоматически сохранить старое обещание подтвержденного старта на новую дату.

## bookings

Новая таблица вместо расширения обязательного student_chat_id в legacy leads: сохраняем совместимость старой обработки обращений. Legacy leads остаются в отдельной вкладке до завершения обработки; новые групповые заявки пишутся только в bookings.

- id: UUID, public_reference: случайный публичный номер, unique; номер не служит авторизацией.
- group_id: FK groups.id; nullable только для контролируемого импорта старых нераспределенных обращений, новые заявки требуют группу.
- name: строка 1..100 символов; phone: нормализованное международное представление 7..15 цифр с ведущим `+`.
- student_chat_id: nullable Telegram chat id, берется только из проверенного Telegram webhook; web не назначает его.
- source: `telegram|site_form|site_chat|legacy`.
- status: `pending|confirmed|declined|cancelled|completed`; revision>=1.
- consent_version: непустой ID текста согласия; consent_at: UTC.
- created_at/updated_at: UTC; terminal_at: nullable UTC, первая terminal дата неизменна.
- pii_erased_at: nullable UTC; после удаления name/phone/student_chat_id становятся NULL.

Переходы: pending -> confirmed/declined/cancelled; confirmed -> cancelled/completed. Terminal обратно не открывается, новая запись получает новый ID. Перенос ученика меняет group_id с сохранением status, проверкой target revision, открытого набора и capacity. При изменении даты группы status confirmed у ученика сохраняется; уведомление просит связаться, если новая дата не подходит. Автоматической отмены ученика при переносе нет.

Pending не резервирует место; если confirmed уже равно capacity, новые отправки на эту группу отклоняются. Два pending могут конкурировать за одно место, подтверждение защищено SQL trigger. Снижение capacity, отмена группы и переносы также транзакционны. Cancel group отменяет pending/confirmed, атомарно создает события; completed не трогается.

Совпадение нормализованного телефона выводит флаг possible_duplicate только сотруднику. Телефон не unique; блокирующий unique по нему запрещен. Нет неявной авторизации/объединения по телефону.

## commands, audit и guards

- command_results: operation_id primary key (128+ бит), scope, payload_digest, result_code, entity_id, created_at, expires_at.
- Для hash с PII использовать HMAC с серверным ключом, не простой hash коротких телефонных номеров. Повторные web keys сохраняются 24h; business IDs и уникальные Telegram update IDs защищают отдельно. После TTL web UI запрещает автоматическую повторную отправку старой квитанции и предлагает проверить у школы.
- command_guards: operation_id, expected_revision NOT NULL, actual_revision NOT NULL, CHECK(expected_revision=actual_revision). Вставка/удаление внутри batch, не долгоживущая блокировка.
- audit_events: UUID, entity_type/id, operation_id, actor_id, action, old/new state с разрешенными полями дат/статусов/group_id, created_at. Никакого имени ученика/телефона/исходного тела. actor_id сотрудника нужен для ответственности; срок 180d.

## conversations, inbox, chat_leases, outbox

Существующие conversations получают уникальный случайный id и revision>=1 для новой анкеты. chat_id остается доверенным получателем внутри сессии; data содержит шаг/временный контакт, expires_at<=created_at+24h. Outbox может ссылаться на conversation_id до создания booking. После каждого изменения шага прежние prompts с conversation_revision становятся superseded. На завершении анкеты ее ожидающие prompts становятся superseded, финальный ответ ссылается на booking; на истечении срока prompts отменяются до удаления сессии.


- inbox: update_id primary key; chat_id; payload (ограниченное исходное событие); state `pending|processing|done|failed`; attempts>=0; retry_at, lease_until nullable, lease_token nullable; created_at; expires_at<=created_at+24h.
- chat_leases: chat_id primary key, lease_until, lease_token. Старая обработка после истечения lease не может завершить доменную мутацию без проверки токена в batch.
- Обрабатывать самый ранний незавершенный из принятых событий чата по update_id; если retry_at еще не наступил, последующие не обгоняют его. Поздно доставленное событие проверяется против версии состояния, нельзя обещать порядок недоставленных updates; допускается 1 исполнитель на чат. Повторный update_id не сбрасывает state/attempts. После удаления payload оставлять только update_id/done marker до 7d, без chat_id. Через 24h неудачи становятся видимой технической задачей без raw payload.
- outbox: id, revision>=1, unique dedup_key(event_id, recipient_role, recipient_key), booking_id/group_id/conversation_id nullable FK, event_type, safe_template_id, conversation_revision nullable, booking_revision nullable, group_revision nullable, recipient_key (booking_id либо conversation_id либо staff target alias, без PII), recipient_role `student|staff|manual`, state `pending|sending|sent|failed|manual_contact|resolved|superseded`, attempts, retry_at, lease_until/token nullable, provider_message_id nullable, created_at, sent_at nullable, terminal_at nullable, resolved_at/actor nullable. Для sent/failed/resolved/superseded terminal_at фиксируется один раз; для manual_contact отсчет идет после resolved, абсолютный предел записи очереди 180d. Телефон/имя/текст сообщения/полный chat_id не дублируются в payload, разрешаются по ссылке непосредственно перед отправкой. Админ чат задан конфигурацией.
- Перед отправкой проверяются текущие booking_revision/group_revision: старое подтверждение после отмены становится superseded; событие переноса порождает отдельное уведомление на каждую booking, дедуп одного ученика не подавляет остальных. Исчерпание 24h retry -> failed/manual_contact, видно в админке. Блокировка бота -> manual_contact без бесконечных повторов. Выбор staff карточки: номер заявки, группа и защищенная ссылка, без персональных контактов.
- retry: failed/manual_contact -> pending, только пока контакт доступен; contacted: manual_contact/failed -> resolved с actor/time и revision, без повторной бизнес-команды. При удалении PII нерешенные manual_contact -> resolved с причиной contact_expired.
- Manual-contact задача содержит только ссылку на booking, назначение/результат звонка и timestamp; отдельная таблица не нужна для v1.

## Retention и индексы

PII booking удаляется в min(created_at+180d, terminal_at+90d); если terminal_at нет, только абсолютный срок. pii_erased_at фиксируется, дальнейшая отправка запрещена. Нет продления при updated_at. Старый lead cleanup сохраняется для legacy.

Inbox payload/черновики <=24h, completed update markers <=7d. Outbox terminal <=30d, любой outbox <=180d, но немедленно теряет возможность отправить PII при удалении контакта. Audit <=180d, command_results <=24h, без raw ответа с PII. Backup: шифрованный, доступ ограничен, ротация <=7d; не используется как онлайн источник и после restore обязательна очистка до открытия доступа. Срок backup является отдельно раскрытым исключением технических копий, а не продлением работы с контактом.

Индексы: groups(service_id, lifecycle, starts_at_utc), bookings(group_id,status), bookings(phone) для авторизованного поиска, bookings(created_at,terminal_at), inbox(state,retry_at), inbox(chat_id,update_id), outbox(state,retry_at), audit(entity_id,created_at). После удаления PII phone index не содержит прежний номер.
