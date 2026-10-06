# План реализации: расписание и выбор обучения

Date: 2026-10-06. Spec: spec.md. Рабочая ветка main; feature-directory независим от Git-ветки.

## Summary

Три разрешенных изменения выполняются в существующем стеке. Backend поддерживает будущие группы из якоря; frontend помогает выбрать формат и рассчитывает выбранные расходы; тренировка показывает главное действие раньше настроек.

## Technical Context

- Статика HTML/CSS/ES modules, доменная логика JS отдельно от DOM.
- Worker TypeScript, Wrangler 4.127.1, D1; существующие canonical commands/revisions/audit.
- Node tests, Vitest+D1 fixtures, Playwright1.63.0, Python pytest.
- Прогресс тренировки остается в localStorage, бюджет не сохраняет персональные данные.
- Расписание читает публичный Worker, цены использует существующий прайс и обновление каталога чата.
- Scope: главная, training, Worker scheduler; без новой библиотеки или внешнего планировщика.

## Constitution Check

PASS до и после дизайна: архитектура сохранена, пользователь подтвердил якорь дат, цены читаются из существующего прайса, доменная логика тестируется отдельно, !notes игнорируется, отправка и подтверждение заявки различаются. Публикация и cutover не заявляются без выполнения.

## Project Structure

- bot/src/groups.ts и модуль recurring scheduler, migrations и backend tests.
- index.html, css/course-choice.css, js/course-budget-logic.js и js/course-budget.js.
- bilety/trenirovka/index.html, js/training.js, css/training-start.css.
- js/tests/course-budget.test.js, tests/browser/course-choice.spec.js и training-start.spec.js.

## Decisions and ownership

Backend agent владеет bot/src, migrations, tests и README. Training agent владеет training HTML/JS/new CSS и отдельным browser test. Основной агент владеет главной, budget modules/tests и всеми specs/status. Общие CSS не меняются без необходимости; версии измененных ресурсов согласуются.

Автоматический режим opt-in. Он сохраняет календарную позицию группы и не отменяет ручные решения. Scheduler использует существующий атомарный механизм, retries не создают дублей. Cron идет UTC, расчет дат учитывает Тбилиси.

Карточки используют цены того же data-price-service, что прайс. Калькулятор читает канонические строки прайса, обновляется при изменении DOM каталога, арифметика в minor units. Неизвестная выбранная цена блокирует итог. Расчет не обещает количество необходимых занятий; справка/первые экзамены добавляются отдельно по выбору.

## Phases

1. Specification/design и независимые backend/training исследования.
2. Backend regression и scheduler; cards/calculator; trainingstart.
3. Интеграция, обязательные проверки и ручной CUAdesktop/mobile.
4. Независимое ревью расписания и расчета; исправление замечаний.
5. Обновление статуса; готовый просмотр и реальные ограничения cutover.

## Release dependency

В Worker нет ACCESS_* и ADMIN_CHAT_ID/ADMIN_IDS; текущий publicAPI503. У владельца запрошены email и staffIDs. Не обходить Access или notification routing ради включения записи. Живая доставка, backup/migration и cutover требуют фактической настройки и отдельной приемки. Документы и локальные fixtures не подтверждают живую готовность.

## Локальная проверка, 2026-10-06

Реализованы карточки форматов, калькулятор с единым прайсом, старт и продолжение тренировки перед настройками. Backend поддерживает три будущие группы через 14 дней от 2026-10-05, 19:00 Asia/Tbilisi, 12 мест. Настройки ROLLING_SCHEDULE_ENABLED/ANCHOR_DATE/START_TIME/CAPACITY описаны в bot/README.md; автоматизация выключена до явного включения.

Проверки: 104 Node, 225 Python tools+chat_agent, 105 Playwright на 1280/390/320 px PASS. CUA: карточки и расчёт 690 на desktop/mobile, тренировка новое/продолжение и клавиатура по отчёту профильного агента. Генераторы llms-full и sitemap выполнены. Frontend review без подтверждённых дефектов. Backend review обнаружило повторный перенос с потерей второй покинутой позиции. Исправление сохраняет все покинутые даты; регрессия падала до правки и прошла после нее. Свежие 220 backend tests и typecheck PASS, повторное независимое ревью clear.

Живая приемка T009 остается открытой: отсутствуют Access и staff Telegram настройки. Production migration, включение автоматизации, commit, push и deploy не выполнялись.
