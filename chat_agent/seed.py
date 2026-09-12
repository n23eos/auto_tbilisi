"""Начальный публичный прайс; дальнейшие изменения происходят только через каталог."""

from chat_agent.facts import Price

# Значения перенесены из index.html#prices, где указана проверка 31.08.2026.
# 31.12 — операционный срок повторной проверки, а не обещание неизменной цены.
PRICES = [
    ('theory_group', 'Теория в группе', 15000, 'course'),
    ('theory_individual_online', 'Индивидуальная теория онлайн', 28000, 'course'),
    ('theory_online_lesson', 'Одно занятие теории онлайн', 2800, 'lesson'),
    ('theory_company_2', 'Онлайн своей компанией, 2 человека', 21000, 'person_course'),
    ('theory_company_3', 'Онлайн своей компанией, 3 человека', 18000, 'person_course'),
    ('theory_company_4', 'Онлайн своей компанией, 4 человека', 15000, 'person_course'),
    ('driving_ground', 'Вождение на площадке', 4000, 'lesson'),
    ('driving_city', 'Вождение в городе', 5000, 'lesson'),
    ('medical_certificate', 'Медицинская справка', 4500, 'item'),
    ('training_certificate', 'Справка об обучении', 5000, 'item'),
    ('state_theory_first', 'Госпошлина: теория, первая попытка', 5500, 'item'),
    ('state_theory_retry', 'Госпошлина: пересдача теории', 4000, 'item'),
    ('state_city_exam', 'Госпошлина: экзамен в городе', 9000, 'item'),
    ('state_ground_retry', 'Госпошлина: пересдача площадки', 4000, 'item'),
    ('state_priority_exam', 'Госпошлина: ближайшая дата экзамена', 25000, 'item'),
    ('international_license', 'Международное водительское удостоверение', 10900, 'item'),
]


def seed(catalog, *, actor='initial-import'):
    existing = {item['service_id'] for item in catalog.services()}
    for service_id, name, amount, unit in PRICES:
        if service_id not in existing:
            catalog.save_price(Price(service_id, name, amount, 'GEL', unit,
                'index.html#prices', '2026-08-31', '2026-12-31'),
                expected_revision=0, actor=actor)
    if not any(item['service_id'] == 'theory_group' for item in catalog.admin_snapshot()['groups']):
        catalog.save_group('theory_group', None, 'unknown', expected_revision=0, actor=actor)
