"""Локальная fixture-демонстрация; не обращается к DeepSeek."""

from datetime import date
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from chat_agent.facts import Catalog, Price, render_price, validate_price


def main():
    with TemporaryDirectory(prefix='school-harness-') as folder:
        catalog = Catalog(Path(folder) / 'demo.sqlite3')
        catalog.save_price(Price('theory_group', 'Теория в группе', 15000, 'GEL', 'course',
                                'fixture:demo', '2026-09-12', '2026-09-12'),
                           expected_revision=0, actor='fixture')
        source = catalog.get_school_info('theory_group', today=date(2026, 9, 12))
        for attempt, amount in enumerate((20000, 15000)):
            draft = {'service_id': 'theory_group', 'amount_minor': amount, 'currency': 'GEL', 'unit': 'course'}
            errors = validate_price(draft, source)
            print(json.dumps({'mode': 'fixture', 'attempt': attempt, 'draft': draft,
                              'validation': 'FAIL' if errors else 'PASS', 'errors': errors}, ensure_ascii=False))
            if not errors:
                print(render_price(source))


if __name__ == '__main__':
    main()
