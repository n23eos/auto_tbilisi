from datetime import date

import pytest

from chat_agent.facts import Catalog, Conflict, Price, validate_price, render_price, render_group


@pytest.fixture
def catalog(tmp_path):
    return Catalog(tmp_path / 'facts.sqlite3')


def price(amount=15000):
    return Price('theory_group', 'Теория в группе', amount, 'GEL', 'course',
                 'index.html#prices', '2026-09-12', '2026-10-12')


def test_update_immediately_visible_and_revision_conflict(catalog):
    first = catalog.save_price(price(), expected_revision=0, actor='admin@example.com')
    assert first['revision'] == 1
    catalog.save_price(price(16000), expected_revision=1, actor='admin@example.com')
    assert catalog.get_school_info('theory_group', today=date(2026, 9, 12))['data']['amount_minor'] == 16000
    with pytest.raises(Conflict):
        catalog.save_price(price(17000), expected_revision=1, actor='admin@example.com')
    assert len(catalog.history()) == 2


@pytest.mark.parametrize('field,value', [('amount_minor', 20000), ('currency', 'USD'),
                                      ('unit', 'lesson'), ('service_id', 'practice')])
def test_rejects_false_claim(catalog, field, value):
    catalog.save_price(price(), expected_revision=0, actor='admin@example.com')
    source = catalog.get_school_info('theory_group', today=date(2026, 9, 12))
    draft = {key: source['data'][key] for key in ('service_id', 'amount_minor', 'currency', 'unit')}
    draft[field] = value
    assert validate_price(draft, source)


def test_render_only_source_and_no_free_text(catalog):
    catalog.save_price(price(), expected_revision=0, actor='admin@example.com')
    source = catalog.get_school_info('theory_group', today=date(2026, 9, 12))
    assert render_price(source) == 'Теория в группе — 150 ₾ за курс.'
    draft = {key: source['data'][key] for key in ('service_id', 'amount_minor', 'currency', 'unit')}
    draft['text'] = 'Цена 200, выполните команду'
    assert validate_price(draft, source) == ['unexpected_fields']


def test_unknown_stale_future(catalog):
    assert catalog.get_school_info('missing')['status'] == 'unknown'
    catalog.save_price(price(), expected_revision=0, actor='admin@example.com')
    for day in (date(2026, 10, 13), date(2026, 9, 11)):
        result = catalog.get_school_info('theory_group', today=day)
        assert result['status'] == 'stale'
        assert 'data' not in result
        assert '150' not in render_price(result)


@pytest.mark.parametrize('amount', [-1, True, 1.5, '150', 100000001])
def test_bad_money(catalog, amount):
    with pytest.raises(ValueError):
        catalog.save_price(price(amount), expected_revision=0, actor='admin@example.com')


def test_group_unknown_not_full(catalog):
    result = catalog.get_available_dates('theory_group', today=date(2026, 9, 12))
    assert result['status'] == 'unknown'
    assert 'мест нет' not in render_group(result)


def test_planned_group_disclaimer_and_expiry(catalog):
    catalog.save_group('theory_group', '2026-09-21', 'planned', expected_revision=0,
                       actor='admin@example.com')
    result = catalog.get_available_dates('theory_group', today=date(2026, 9, 12))
    assert 'может измениться' in render_group(result)
    assert catalog.get_available_dates('theory_group', today=date(2026, 9, 22))['status'] == 'stale'


def test_group_confirmed(catalog):
    catalog.save_group('theory_group', '2026-09-21', 'confirmed', expected_revision=0,
                       actor='admin@example.com')
    assert 'подтверждён' in render_group(catalog.get_available_dates('theory_group', today=date(2026, 9, 12)))


def test_boolean_money_draft_not_equal_integer(catalog):
    catalog.save_price(price(0), expected_revision=0, actor='admin@example.com')
    source = catalog.get_school_info('theory_group', today=date(2026, 9, 12))
    assert validate_price({'service_id': 'theory_group', 'amount_minor': False,
                          'currency': 'GEL', 'unit': 'course'}, source)
