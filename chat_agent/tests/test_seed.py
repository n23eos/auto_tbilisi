from datetime import date

from chat_agent.facts import Catalog, Price
from chat_agent.seed import seed


def test_seed_adds_classroom_course_without_rewriting_saved_prices(tmp_path):
    catalog = Catalog(tmp_path / 'facts.sqlite3')
    saved_amounts = {
        'theory_company_2': 28000,
        'theory_company_3': 23000,
        'theory_company_4': 18000,
        'theory_individual_online': 35000,
        'theory_online_lesson': 3500,
    }
    for service_id, amount in saved_amounts.items():
        catalog.save_price(Price(service_id, service_id, amount, 'GEL', 'course',
            'admin', '2026-10-14', '2026-12-31'), expected_revision=0, actor='editor')
    saved = catalog.admin_snapshot()['prices']

    seed(catalog)

    current = {row['service_id']: row for row in catalog.admin_snapshot()['prices']}
    for row in saved:
        assert current[row['service_id']] == row
    classroom = catalog.get_school_info('theory_individual_classroom', today=date(2026, 10, 14))
    assert classroom['status'] == 'success'
    assert classroom['data']['amount_minor'] == 35000
    assert classroom['data']['currency'] == 'GEL'
    assert classroom['data']['unit'] == 'course'
    assert classroom['data']['verified_at'] == '2026-10-14'

    snapshot, history = catalog.admin_snapshot(), catalog.history()
    seed(catalog)
    assert catalog.admin_snapshot() == snapshot
    assert catalog.history() == history
