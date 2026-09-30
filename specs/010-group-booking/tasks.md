# Tasks: единые группы и запись

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/api.md, quickstart.md.
**Tests**: обязательны по FR-014. Галочки отражают локальную реализацию и проверки. Production release gates сохраняются отдельно в review.md.

## Phase 1: Setup

- [X] T001 Сверить окружение/lockfiles и карту существующих reader/writer в bot/wrangler.toml, bot/package-lock.json, chat_agent/README.md; сохранить проверенные параметры и неизвестные production в specs/010-group-booking/review.md без секретов.
- [X] T002 Подготовить локальную D1 и fixtures фиксированного времени/синтетических заявок в bot/test/group-fixtures.ts; отделить staging от production в bot/README.md.

## Phase 2: Foundational

Блокирует интеграции. Независимые проверки SQL и auth выполняются до открытия write API.

- [X] T003 Реализовать аддитивную схему в bot/migrations/0003_group_booking.sql и типы bot/src/booking-types.ts по data-model.md: groups.id «UUID, immutable primary key», service_id «theory_group», sequence «положительное целое, unique(service_id, sequence), immutable», start_date «YYYY-MM-DD», start_time «HH:MM», timezone «Asia/Tbilisi», date_status «planned|confirmed», enrollment_open «boolean», lifecycle «scheduled|cancelled|completed», capacity «целое 1..100, default 12», revision «целое >=1», nullable terminal timestamps; FK, UTC, индексы, максимум три будущие и запрет одной даты для двух scheduled групп.
- [X] T004 В той же миграции и bot/src/booking-types.ts последовательно добавить bookings по data-model.md: public_reference unique, group_id FK nullable только для legacy, name «1..100 символов», phone «7..15 цифр с ведущим +», student_chat_id nullable из доверенного webhook, source «telegram|site_form|site_chat|legacy», status «pending|confirmed|declined|cancelled|completed», revision>=1, consent_version непустой, consent_at UTC, terminal_at фиксированный, pii_erased_at nullable; после удаления PII name/phone/chat_id NULL. Добавить command_results/guards/audit/inbox/chat_leases/outbox со всеми enum, unique dedup keys, nullable leases и TTL из модели.
- [X] T005 Написать SQL-конкурентные проверки guard, capacity и rollback в bot/test/schema.test.ts; реализовать транзакционный helper в bot/src/booking-commands.ts: CHECK(expected_revision=actual_revision), уникальный operation_id, HMAC digest, result replay, 409 на измененное тело. Доказать, что zero-row CAS/INSERT SELECT и NULL не допускают следующих безусловных записей; guard через VALUES/scalar subquery. Admission проверки lifecycle/start/open/revision/capacity внутри batch, CAPTCHA вне business digest.
- [X] T006 [P] Реализовать и протестировать Access JWT/allowlist/Origin/CSRF/fail-closed в bot/src/admin-auth.ts и bot/test/admin-auth.test.ts; закрепить проверенную JWT-зависимость в bot/package.json и lockfile без ручной криптографии.
- [X] T007 Подключить независимые public/admin/webhook routes и Worker admin assets в bot/src/index.ts и bot/wrangler.toml; не требовать TG secrets для public GET; сохранить два секрета webhook, не вводить [vars].

## Phase 3: US1 - Управление расписанием (P1)

Цель: одно место управления. Проверка: примеры дат и атомарный конфликт без опубликованного UI сайта.

- [X] T008 [P] [US1] Добавить проверки create/move/append/confirmed conflict/revision/calendar/timezone в bot/test/groups.test.ts с примерами US1, границами года и старта 19:00, сдвигом ровно +14/-14 дней без промежуточной unique collision.
- [X] T009 [US1] Реализовать чистый расчет и транзакционные команды в bot/src/groups.ts: 1-3 группы, 14 дней, stable IDs/sequence, explicit append, preview/commit, reset перенесенной confirmed в planned, audit/outbox атомарно.
- [X] T010 [US1] Реализовать admin schedule API в bot/src/booking-api.ts по contracts/api.md: серверный повтор расчета preview, проверка общей revision, полное отклонение каскада при confirmed/коллизии.
- [X] T011 [US1] Создать мобильную админку bot/admin/index.html, bot/admin/admin.js, bot/admin/admin.css: календарь, время, статус даты/набор отдельно, preview до/после и затронутые записи, сохранение ввода при конфликте.

## Phase 4: US2 - Одинаковые даты везде (P1)

Цель: сайт и оба бота читают один источник. Проверка: изменение в админке видно во всех каналах, ошибка не возвращает старую дату.

- [X] T012 [P] [US2] Добавить тест public GET no-store, фильтра старта, отсутствия PII и unavailable в bot/test/booking-api.test.ts; реализовать чтение primary и availability в bot/src/booking-api.ts после T010.
- [X] T013 [P] [US2] Добавить раздел ближайших групп в index.html, js/groups-logic.js, js/groups.js, css/style.css и js/tests/groups.test.js: polling видимой вкладки 30s/focus, очистка актуальности при ошибке, без статических дат/fallback.
- [X] T014 [P] [US2] Добавить read-only адаптер chat_agent/group_client.py, tests/test_group_client.py, интеграцию в harness.py/facts.py: timeout3s, валидированный snapshot, без SQLite fallback. Отключить старый HTTP writer групп в http_app.py, в static/admin.js заменить редактор ссылкой на новую админку.
- [X] T015 [US2] Обновить bot/src/router.ts и тесты bot/test/router.test.ts: текущий список из groups, компактные callback <=64 bytes, stale button refresh; /set дата_группы больше не меняет facts, возвращает ссылку.
- [X] T016 [US2] Согласовать правила дат в baza-znaniy/01-obuchenie.md, 07-pravila-otvetov-bota.md и соответствующих dlya-bota TXT; проверить остальные производные экспорты, пересобрать bot/src/generated/kb.ts через bot/scripts/build-kb.mjs. Добавить в specs/001-deepseek-chat/spec.md ссылку на заменяющее правило specs/010 без переписывания истории.

## Phase 5: US3 - Запись тремя способами (P1)

Цель: одна сохраненная заявка на выбранную группу. Независимая проверка на fixtures: повторы, дата во время анкеты, отсутствие PII в модели.

- [X] T017 [P] [US3] Добавить проверки idempotency same/different body, expiry24h, group changed/full/closed, spoof fields и phone duplicate в bot/test/bookings.test.ts и bot/test/booking-api.test.ts после T012.
- [X] T018 [US3] Реализовать pending booking в bot/src/bookings.ts и POST в bot/src/booking-api.ts: согласие, capacity admission, group revision, результат только после commit, audit/outbox, случайный web key128+ бит и неперсональная квитанция.
- [X] T019 [US3] Добавить public abuse controls в bot/src/booking-api.ts и bot/test/booking-api.test.ts: allowlist Origin, body<=16KB, rate limits, server Turnstile, безопасный replay после использованного captcha token.
- [X] T020 [US3] Реализовать общий js/booking-form.js и js/tests/booking-form.test.js; подключить к js/main.js и js/chat.js, index.html/css/chat.css: selected group, повторное согласие новой даты, сохранение key при timeout; FormSubmit выключается только при cutover. Форма чата не зависит от доступности AI и не отправляет PII модели.
- [X] T021 [US3] Интегрировать группы/ревизии и group-specific согласие в bot/src/conversation.ts, router.ts, types.ts и тесты анкеты; использовать новую booking command, сохранить legacy callbacks отдельно. Зависит от T030-T031 для надежного приема.

## Phase 6: US4 - Состав и подтверждение (P1)

Цель: управлять заявками без смешения записи и старта. Проверка: последнее место, перенос, отмена и недоставленное уведомление.

- [X] T022 [P] [US4] Добавить конкурентный тест 20 confirm на последнее место, transfer rollback, capacity reduction, cancel group в bot/test/bookings.test.ts после T017.
- [X] T023 [US4] Реализовать confirm/decline/cancel/complete/transfer, неизменный terminal_at, cancel группы и capacity triggers в bot/src/bookings.ts и новых миграциях при необходимости; проверки group/booking revision, audit/outbox в одном batch.
- [X] T024 [US4] Реализовать защищенные list/detail/action endpoints с cursor<=50 в bot/src/booking-api.ts, тесты доступа и отсутствия PII публично в bot/test/booking-api.test.ts; поиск не логировать.
- [X] T025 [US4] Добавить список, фильтры, поиск, pending/confirmed, possible_duplicate, manual-contact и legacy вкладку в bot/admin/admin.js и admin.css после T011; legacy leads не назначать группам по догадке.
- [X] T026 [US4] Реализовать staff TG карточку без PII и callbacks в bot/src/router.ts, новые тесты actor+chat+revisions; карточка с номером, группой и защищенной ссылкой, действия через те же команды.
- [X] T027 [US4] Добавить запись результата звонка и безопасный retry только доставки в bot/src/outbox.ts, booking-api.ts, bot/admin/admin.js; не повторять confirm вместе с повтором сообщения. Зависит от T032.

## Phase 7: US5 - Надежность (P1)

Цель: возобновление незавершенной работы. Выполняется до T021 и до приема реальных заявок, несмотря на порядок разделов историй.

- [X] T028 [P] [US5] Добавить failure-injection тесты до/после inbox/domain commit и stale lease в bot/test/inbox.test.ts; проверить последовательность событий одного chat_id и concurrent duplicate.
- [X] T029 [P] [US5] Добавить failure-injection доставки, 429/retry_after, 403, crash после send, superseded даты и manual-contact в bot/test/outbox.test.ts.
- [X] T030 [US5] Реализовать durable прием, per-chat lease с fencing token, повтор и идемпотентное завершение в bot/src/inbox.ts; payload<=24h, update markers<=7d, без повторного перехода анкеты. Расширить bot/src/conversation.ts и миграцию UUID/revision сессии: outbox prompt ссылается на conversation_id до booking, TTL<=24h, устаревшие prompts отменяются. Запретить обгон earliest незавершенного accepted update с будущим retry_at. Тесты T028 обязательны.
- [X] T031 [US5] Подключить inbox в bot/src/index.ts вместо преждевременного processed_updates; 200 только после durable insert, 503 при отказе D1, immediate drain и cron fallback; webhook max_connections=1 описать в bot/README.md, update ID дедуп независимо от настройки.
- [X] T032 [US5] Реализовать outbox dispatcher в bot/src/outbox.ts, общий scheduled в index.ts/wrangler.toml: leases, интервалы1/5/15/60min далее hourly<=24h, attempts/retry_after, sent не значит прочитано, карточки без PII, неотправленные старые даты/подтверждения/prompts superseded по версиям; unique(event_id,role,recipient_key) не подавляет остальных учеников. Сохранить nightly cleanup отдельно от minute dispatch.
- [X] T033 [US5] Расширить bot/src/cleanup.ts и bot/test/cleanup.test.ts: min(created+180d,terminal+90d), payload/черновики<=24h, audit<=180d, outbox terminal<=30d, update markers<=7d, commands<=24h; NULL персональных полей, отмена отправки после удаления, conversation refs/prompts<=24h, outbox terminal_at и resolved/contacted, абсолютный предел outbox180d, legacy cleanup сохранен.
- [X] T034 [US5] Описать мониторинг inbox/outbox lag и failed, backup<=24h/rotation7d, recovery без повторной рассылки в bot/README.md; выполнить восстановление в изолированной D1, результаты RTO<=60m/RPO<=24h записать в specs/010-group-booking/review.md. Не включать фоновую внешнюю автоматизацию без разрешения.

## Phase 8: Polish и выпуск

- [ ] T035 Добавить сквозные browser fixtures в tests/browser/group-booking.spec.js; проверить SC-001..006 по quickstart.md, CUA320/390/1280 и отказ VPS при рабочей записи, сохранить результаты в specs/010-group-booking/review.md.
- [X] T036 Согласовать cache-busting всех затронутых entrypoints/CSS в HTML по CLAUDE.md; выполнить npm test, bot npm test/typecheck, pytest tools+chat_agent/tests, npm run test:browser, KB checks; обновить CLAUDE.md сведениями о новой части, не ослабляя прежние правила.
- [ ] T037 Составить и отрепетировать cutover/rollback по plan.md в bot/README.md: exports, legacy mapping, один writer, отключение /set/Python writer/FormSubmit dual-send; отметить release gates в specs/010-group-booking/review.md. Production действия только после разрешения.
- [X] T038 Провести независимое ревью безопасности/конкуренции/ретеншна и закрыть замечания; обновить specs/010-group-booking/review.md и раздел текущего состояния в .plan.md. При разрешении выпуска записать фактические commit/push/deploy и живые проверки отдельно.

## Dependencies & Execution Order

T001-T007 -> US1 -> US2. US3 зависит от groups, но backend tests могут работать на fixtures без UI. US4 зависит от booking commands. US5 основы T028-T032 выполняются после foundations параллельно с US1/US2, до T021. T027 после T032. T033 после финальной модели booking и queues. T034-T038 закрывают release.

Все writers одного файла назначаются одному исполнителю или выполняются последовательно. [P] означает возможность работы в отдельных файлах после завершения указанных зависимостей, не разрешает пересекающиеся правки.

Примеры параллельной работы:
- US1: T008 tests вместе с T006 auth после схемы; реализация следует проверкам.
- US2: T013 frontend и T014 Python после фиксации public contract; router интеграция отдельно.
- US3: T017 API tests и подготовка UI формы после готовности contracts; endpoint writer один.
- US4: T022 test fixture и T025 UI после T024, если файл тестов свободен; доменные writers последовательны.
- US5: T028 inbox tests и T029 outbox tests независимы; index.ts интегрирует один ответственный.

## Implementation Strategy

Первый показываемый срез: единое управление датами и три читателя (US1+US2). Он полезен без приема записей. Полный MVP записи: US1-US5, все reliability gates до production. Оплата/SMS/свободные AI-команды/автоматический rolling horizon не входят.

38 задач: setup2, foundations5, US1=4, US2=5, US3=5, US4=6, US5=7, final4. Содержательные тесты требуются спецификацией, галочки меняются только после фактической реализации и проверки.

## Состояние приемки, 2026-09-29

T034 закрыт локальной репетицией: export Wrangler и import в изолированную D1,
совпадают groups/bookings/command_results IDs и строки; FK/integrity PASS,
88.9 секунды с подготовкой, синтетический RPO 0. Production backup/rotation
и реальный RPO не проверены, это обязательный release gate.

T035: локальные fixtures и визуальные проверки выполнены; живой сквозной
канал сайт/Telegram/Python требует staging конфигурации и остается открытым.
T037: runbook написан, но staging cutover/rollback не выполнен.
Реальные даты, Worker hostname, D1 ID, Access и Turnstile нельзя подставлять
по догадке. Включение production приема отдельно от локальной реализации.
