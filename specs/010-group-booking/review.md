# Проверка реализации, 2026-09-29

## Результат

По команде владельца «го» функция реализована локально. Worker+D1 хранит группы,
заявки, команды, audit и очереди. Мобильная админка управляет датами и составом;
сайт, Telegram и Python используют единый источник после настройки cutover.
Production прием пока не включен, публикация не выполнялась.

Управление: создать 1-3 группы, интервал 14 дней, явно добавить следующую,
перенести выбранную и следующие предварительные с предпросмотром. ID группы
не меняется. Подтверждение старта и подтверждение места ученика разделены.
Анкеты сайта и чата обходят AI, запись подтверждает сотрудник.

## Закрыто после независимого ревью

- Перезапуск после domain commit больше не разбирает тот же Telegram update
  как следующий шаг анкеты. Проверяется атомарный command result до handler;
  failure injection использует настоящий routeUpdate.
- Legacy migration ограничивает expiry анкеты 24 часами, не оживляет expired
  и закрывает invalid timestamps. Проверка выполняет реальные 0001/0002/0003.
- Поиск телефона/имени идет защищенным POST JSON с CSRF; q в GET отклоняется,
  контакт не попадает в URL инфраструктурных логов.
- Запись прошлой группы содержит group_revision. Завершение/отмена доступна
  без ручной загрузки архива.
- Детали записи содержат ограниченную историю action/actor/time без копий PII.
- Ошибки очереди журналируются безопасным кодом, без произвольного message/stack.
- Единственный snapshot расписания используется Python для ответа и evidence.

Независимый routing_reviewer (gpt-5.6-sol/high) перепроверил исправления.
Runtime auth проверяется JWT jose RS256, issuer/audience/expiry/email allowlist,
Origin и подписанным CSRF. Доступ через прямой workers.dev отклоняется.
Worker assets проходят авторизацию благодаря run_worker_first.

## Реально выполненные проверки

- `npm test`: 97 PASS, включая согласованность версий ресурсов.
- `cd bot && npm test`: 205 PASS; `npm run typecheck`: PASS.
- `.venv/bin/python -m pytest tools chat_agent/tests -q`: 221 PASS.
- Полный browser runner: 42 PASS на 1280/390/320 px; после добавления истории
  повторный admin runner: 15 PASS. Полный результат и целевой повтор различаются.
- KB: 17 PASS, экспорт/Worker KB собраны генераторами.
- CUA: локальная админка и сайт с синтетическими датами, выбор группы,
  форма чата, отсутствие JS ошибок; широкий и узкий экраны.
- Fresh local D1: миграции 0001-0004 применены. CAS/guards/rollback, +14/-14,
  capacity, concurrent confirm, idempotency, retention, retry/403/429/stale
  prompts покрыты содержательными тестами.
- `git diff --check`: PASS. Новые booking файлы проверены буквально на
  U+2013/U+2014. Чужие изменения партнеров и раздела о школе сохранены.
- Context7 был недоступен по квоте; использованы официальные первоисточники.

## Восстановление

Репетиция только на синтетической локальной D1, без production экспорта:
Wrangler 4.127.1 export --local, затем execute --local в другую изолированную
копию. Для export использован отдельный временный cwd с локальным state:
данная версия export не поддерживает --persist-to.

Совпали все строки и ID groups (1), bookings (1), command_results (1),
d1_migrations (4). Inbox/outbox/audit пустые в fixture, dispatcher и webhook
не подключались. FK check и integrity check PASS. Время с подготовкой 88.9 s,
синтетический RPO 0. Это проверяет путь восстановления, но не доказывает
production RPO, ротацию backup или поведение живой внешней доставки.

## Обязательные release gates

1. Реальный D1 ID: wrangler.toml пока содержит прежний placeholder.
2. Выделенные Worker hostname, ADMIN_ORIGIN, Access app/audience/email allowlist.
   Для public API hostname/paths должны быть доступны без интерактивного Access;
   admin paths дополнительно защищены приложением и Worker JWT.
3. BOOKING_SECRET и остальные secrets из bot/README.md, реальные Turnstile
   sitekey/secret/allowed hostname; `data-booking-api` и sitekey в HTML.
4. BOOKING_API_URL/BOOKING_ADMIN_URL на VPS. Цены и AI budget остаются SQLite.
5. Согласованный cutover без старых writers дат/FormSubmit dual-send,
   проверка трех каналов в staging, затем rollback rehearsal.
6. Первые реальные даты вводит сотрудник. Даты в тестах не считаются расписанием.
7. Production export, backup не старше 24h, ротация 7d, restore с cleanup,
   остановленными очередями и ручной сверкой старых pending/sending.
8. Живые проверки Access/CSRF, CAPTCHA, webhook и доставки тестовому ученику,
   отсутствие PII в карточке staff, мониторинг lag/failed/manual_contact.

Эти gates нельзя заменить локальными PASS. Production миграции, отправка
сообщений, commit/push/deploy не выполнялись. T035 и T037 остаются открытыми
для staging/выпуска. Следующий этап: настройка окружения и проверка cutover
после разрешения на соответствующие внешние действия.


## Подключение рабочей инфраструктуры, 2026-09-29

Источник: разрешение владельца на пункты 1-4, реальные проверки CLI/API.

- Создана D1 avtoshkola-bot, UUID записан в wrangler.toml.
- Применены production migrations 0001-0004. Исправлена несовместимость
  nested SELECT CASE в триггерах с remote D1: условия перенесены в WHEN.
  Remote FK check пуст; все 12 триггеров присутствуют. Атомарные пробы
  подтвердили лимит групп и capacity, пробные записи полностью откатились.
- Worker опубликован на https://booking.avtoshkola.ge, crons подключены.
  workers.dev и preview URLs отключены. BOOKING_ENABLED=false.
- Создан production Turnstile для avtoshkola.ge и www.avtoshkola.ge.
  Токен Telegram проверен, бот @Autoschool_Tbilisi_bot; webhook не установлен.
  Секреты установлены в Worker и не входят в Git.
- Обнаружен HTTP 403 Cloudflare для default Python User-Agent. Reader
  использует собственный AvtoshkolaGroupReader/1.0; защиты зоны не менялись.
- На VPS подготовлен отдельный кандидат 20260929-group-booking-v2.
  Проверена компиляция 20 Python файлов и WSGI health с изолированным state
  и фиктивным API key, без запросов AI; current и сервис не переключались.
- Изолированный release содержит только booking изменения. Проверено:
  сайт92, bot206/typecheck, Python225; browser45 после подключения чата FAQ.

Осталось: staff email allowlist и Access app, закрытый Telegram чат и IDs
сотрудников, установка webhook, включение приема, cutover сайта/Python,
живая приемка и backup/restore. CLI Cloudflare не имеет прав Access API,
открытая вкладка ожидает входа владельца. Текущий публичный API и админка
возвращают 503 booking_unconfigured, заявки не принимаются.

Сайт не отправлен в GitHub, Python production не переключен. T035 и T037
остаются открытыми; инфраструктурный deploy не равен завершенному выпуску.

Production расписание создано существующими previewSchedule/commitSchedule
по датам владельца: 05.10.2026, 19.10.2026, 02.11.2026. Использованы настройки
админки по умолчанию: 19:00, 12 мест; даты preliminary/planned. Schedule
revision=2, повтор команды вернул replayed=true. Созданы 3 audit events,
bookings/outbox пусты. Временный bootstrap adapter удален.

Production D1 export сохранен в игнорируемом локальном каталоге с правами
0600. Экспорт восстановлен в изолированную SQLite: integrity/FK, три даты,
audit, replay result и ledger 0001-0004 совпали. Учеников в базе нет. Это
проверка содержимого текущего экспорта, не live restore в D1 и не настроенная
регулярная ротация резервных копий.

Чат на странице вопросов подключен к тому же API без визуальной секции групп.
Сквозная проверка FAQ: выбор группы и site_chat POST, без передачи PII в AI.
Сборка KB нормализует типографские тире в короткий дефис по правилам проекта;
цены и фактическое содержание сохранены.

После нормализации KB исправлена фильтрация служебных фраз: parser принимает
короткий дефис и legacy варианты, сохраняя факты и контакты. Три регрессионных
проверки добавлены; повтор tools+chat_agent 225 PASS, bot206/typecheck PASS.
