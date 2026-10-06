# Задачи: расписание и выбор обучения

Input: spec.md, plan.md, research.md, data-model.md, contracts/ui.md. Tests обязательны FR-010.

## Setup

- [x] T001 Зафиксировать спецификацию и ограничения в specs/012-recurring-course-ux/spec.md.
- [x] T002 Подготовить дизайн, контракт и приемку в specs/012-recurring-course-ux/plan.md.

## Foundational

- [x] T003 Сверить existing canonical writes и внешние dependencies в bot/src/groups.ts и bot/README.md.
- [x] T004 Закрепить источники цен и ownership в specs/012-recurring-course-ux/research.md.

## US1 - Автоматические группы и запись

- [x] T005 [P] [US1] Добавить регрессии14дней/timezone/replay/manualexceptions/concurrency в bot/test/rolling-groups.test.ts.
- [x] T006 [US1] Реализовать календарные позиции, atomics и сохранение исключений в bot/src/groups.ts и bot/migrations.
- [x] T007 [US1] Подключить opt-in cron и config в bot/src/index.ts и bot/src/types.ts.
- [x] T008 [US1] Обновить настройки и приемку в bot/README.md.
- [ ] T009 [US1] После staff/Access настройки проверить живую запись по bot/README.md; не отмечать по fixtures.

## US2 - Выбор и бюджет

- [x] T010 [P] [US2] Добавить содержательные регрессии расчета в js/tests/course-budget.test.js.
- [x] T011 [US2] Реализовать чистую арифметику minorunits и unknownprice в js/course-budget-logic.js.
- [x] T012 [US2] Добавить карточки и calculator в index.html и css/course-choice.css.
- [x] T013 [US2] Подключить общий прайс и UI в js/course-budget.js.
- [x] T014 [US2] Проверить переходы, обновление цен и unknownprice в tests/browser/course-choice.spec.js.

## US3 - Старт тренировки

- [x] T015 [P] [US3] Проверить первое действие и resume на390/320 в tests/browser/training-start.spec.js.
- [x] T016 [US3] Поднять старт/resume и разделить подписи в bilety/trenirovka/index.html,js/training.js,css/training-start.css.

## Завершение

- [x] T017 Проверить согласованность версий и полные projectchecks; результаты в specs/012-recurring-course-ux/plan.md.
- [x] T018 Провести CUA и независимое ревью расписания/расчета; отчет specs/012-recurring-course-ux/review.md.
- [x] T019 Обновить .plan-improve.md и каноническую карточку проекта с результатом и реальными блокерами.

## Dependencies and parallel execution

T001-T004 завершены до реализации. US1,US2,US3 независимы по файлам и идут параллельно. Внутри US1 tests предшествуют scheduler, затем config/docs. Внутри US2 logic tests предшествуют UI. T009 зависит от внешней конфигурации, не блокирует локальную реализацию остальных историй. T017-T019 после интеграции.

## Strategy

Все три истории разрешены владельцем. Локальная приемка доказывает реализацию; живая запись требует реальной конфигурации сотрудников и доступов. Публикация отдельно фиксируется только после выполнения.
