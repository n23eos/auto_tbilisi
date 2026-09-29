# Контракты v1

Base URL Worker задается конфигурацией; production hostname пока не назначен. Публичный сайт не получает секреты. Все тела JSON <=16KB; ошибки не включают PII, SQL или stack trace. GET no-store. Timestamp UTC, даты вывода Asia/Tbilisi.

## Публичное расписание

`GET /api/v1/groups?service_id=theory_group`

200: `{schedule_revision, fetched_at, timezone:"Asia/Tbilisi", groups:[{id,revision,start_date,start_time,date_status,enrollment_open,availability}]}`.
`availability`: open/full/closed. Максимум 3, отсортированы по starts_at_utc. Нет клиентов/контактов/числа ожидающих. Пустое расписание: 200 с []; недоступность: 503, не пустой успешный ответ. Число мест можно добавить только после отдельного решения, в v1 достаточно доступности.

## Подача заявки

`POST /api/v1/bookings`, header `Idempotency-Key` случайный 128+ бит, ограниченный длиной 128 ASCII.

Тело: `{group_id, group_revision, name, phone, consent_version, consent:true, source:"site_form"|"site_chat", turnstile_token}`. source недоверенная аналитическая метка, не полномочие. turnstile_token исключен из idempotency digest; replay с новой CAPTCHA и тем же бизнес-телом возвращает прежнюю квитанцию. Дополнительные поля отклоняются. student_chat_id/status/actor_id нельзя прислать из web.

201 новый / 200 replay: `{reference,status:"pending",message:"Заявка принята. Ожидает подтверждения администратора",contact_method:"phone"}`. Сохраненный результат не содержит имени/телефона. 400 invalid, 409 group_changed/group_full/group_closed/idempotency_mismatch, 429 rate_limited, 503 unavailable. При group_changed вернуть только актуальную публичную группу. Повтор после сети использует тот же key/body, новая дата требует явного повторного согласия и нового key.

Нет публичного списка заявок и lookup по номеру/телефону. Истекший key не используется автоматически. Успех Telegram-анкеты содержит ту же reference и статус, но канал contact_method=telegram, доверенная личность извлечена из update.

## Администрирование

Все `/api/admin/v1/*` требуют проверенного Access JWT + allowlist, CSRF и exact Origin на изменениях. GET тоже авторизован. 401/403 без раскрытия сущностей. Telegram быстрые действия дополнительно требуют ADMIN_CHAT_ID и ADMIN_IDS, затем вызывают те же доменные команды. Публичный номер не дает административных прав.

- `GET /api/admin/v1/groups`: текущие группы и архив с cursor, counts pending/confirmed, capacity, revisions.
- `GET /api/admin/v1/bookings?group_id=&status=&cursor=`: <=50 строк, фильтры без персональных данных. Элементы содержат group_revision, включая прошлые группы.
- `POST /api/admin/v1/bookings/search`: `{group_id?,status?,q?,cursor?}`, Access и CSRF обязательны. Поиск имени/телефона только в JSON body, без q в URL и без журналирования тела. GET с q отклоняется. PII только в защищенных ответах.
- `GET /api/admin/v1/bookings/:id`: детали/история, PII только пока retention не истек.
- `POST /api/admin/v1/schedule/preview`: `{expected_revision,action:"create"|"append"|"move"|"cancel", ...}`. create: first_date,time,count 1..3,capacity; append: последний ID; move: group_id,new_date,new_time,scope:"one"|"following_planned",ack_confirmed_move:boolean; cancel: group_id. Возвращает `{expected_revision,normalized_command,changes,affected_bookings,notification_count,warnings}`. Preview не сохраняет бизнес-данных.
- `POST /api/admin/v1/schedule/commit`: normalized_command, expected_revision и Idempotency-Key. Повторяет валидацию и расчет на сервере, не доверяет changes клиента. Сохранение groups/audit/outbox/revision атомарно. 409 schedule_changed/confirmed_conflict/date_collision; ни одной частичной правки.
- `PATCH /api/admin/v1/groups/:id`: `{expected_revision,expected_schedule_revision,date_status,enrollment_open,capacity}`; изменение даты только через preview/commit. Idempotency-Key обязателен.
- `POST /api/admin/v1/bookings/:id/actions`: `{action:"confirm"|"decline"|"cancel"|"complete"|"transfer",expected_revision,group_revision,target_group_id?,target_group_revision?}` + key. group_revision предотвращает подтверждение по старой дате; transfer требует target. Результат `{id,status,revision,notification_state}`.
- `GET /api/admin/v1/notifications?state=failed`: <=50, cursor.
- `POST /api/admin/v1/notifications/:id/actions`: retry/contacted, expected_revision, key. Нельзя повторно исполнять бизнес-операцию кнопкой доставки.

## Telegram

- `menu:gruppa` -> текущий список, кнопка содержит group_id/revision в компактном серверно проверяемом token <=64 bytes. UUID+длинный JSON в callback запрещен; можно использовать короткий server mapping.
- Выбор -> повторная проверка -> анкета -> согласие -> атомарная booking command -> reference.
- /set дата_группы после cutover возвращает ссылку на админку без записи старого facts.
- Staff карточка без имени/телефона: reference, группа, status, ссылка в админку, быстрые кнопки. Любая кнопка заново проверяет actor, booking revision и group revision.
- Исторические карточки leads продолжают legacy обработку; новые booking callbacks имеют отдельный namespace.

## Python чат

`group_client` читает public groups с timeout 3s, передает валидированную структуру детерминированному renderer. Цены остаются прежними. Любая ошибка/невалидный payload -> unavailable, ни SQLite fallback, ни сгенерированная дата. LLM не получает инструмент записи и не создает факт подтверждения. Если вопрос о записи, UI показывает форму выбранной группы; успешный ответ идет от booking API.
