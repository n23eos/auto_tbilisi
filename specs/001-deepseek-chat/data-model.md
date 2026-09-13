# Контракт первого среза

Price: service_id (стабильный ключ), name, amount_minor (целые тетри), currency=GEL, unit=course/lesson/person_course, source_ref, verified_at, valid_until. Период включительный. Источник прайса при импорте — разрешённые публичные тарифы index.html, а не fixture.

Group: service_id, start_date (ISO date или null), status=unknown/planned/confirmed/full. Неизвестность не равна отсутствию мест. Подтверждение вручную, автоматического порога по числу заявок нет.

SQLite facts хранит payload и revision для kind/id; history — actor, время UTC, предыдущий и новый payload, ревизию. Запись и история атомарны, optimistic concurrency контролируется внутри BEGIN IMMEDIATE. Авторизацию actor обязан обеспечить будущий HTTP-слой, само поле actor не даёт прав.

get_school_info(service_id): status=success + data/revision либо unknown/stale без фактического payload. get_available_dates(service_id): unknown/stale либо planned/confirmed/full + data/revision. Неправильный ключ вызывает ValueError; ошибки хранилища будущий harness преобразует в безопасный ответ.

Черновик цены содержит ровно service_id/amount_minor/currency/unit. Валидатор отвергает лишние поля, неверные типы и несовпадения. Рендерер использует только источник, не свободный текст модели. Это не проверяет семантическую правильность выбранной моделью услуги: она отдельно проверяется сценариями intent/уточнения.
