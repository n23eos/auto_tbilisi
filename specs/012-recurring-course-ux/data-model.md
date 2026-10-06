# Данные

- Group,Booking,ScheduleState,Audit,CommandResult: существующие сущности specs/010. Новая принадлежность календарной позиции не меняет ID или даты вручную перенесенной группы. Таблица rolling_schedule_slots: (service_id, slot_date) является первичным ключом, group_id ссылается на Group. Одну дату резервирует не более одной группы; одна группа может резервировать несколько покинутых дат после повторных переносов.
- RecurrenceRule: enabled opt-in,anchorDate2026-10-05,intervalDays14,startTime19:00,timezoneAsia/Tbilisi,horizon3,capacity12. Backend уточняет окончательный configcontract в README.
- BudgetSelection: theoryService выбран из опубликованных форматов или none,groundLessons/cityLessons целые0..100,includeExamCosts boolean.
- PublishedPrice: serviceId,amountMinor целое>=0 либо unknown. Значения берутся из прайса, не из пользовательского произвольного текста.
- BudgetResult: отдельные school/extras lines и subtotalMinor; totalMinor только если все требуемые цены доступны. Ноль уроков не требует цену урока; unknown включенной позиции блокирует итог.
- TrainingSession: неизмененный текущий формат, readonly счетчики с явными подписями.
