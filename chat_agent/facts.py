"""Точные факты: SQLite, контроль ревизий и независимая от модели выдача."""

from dataclasses import asdict, dataclass
from contextlib import contextmanager
from datetime import date, datetime
import json
import re
import sqlite3
from zoneinfo import ZoneInfo

CONTACT = 'Уточните у администратора: +995 599 98 77 07 или WhatsApp https://wa.me/995599987707.'
UNITS = {'course': 'за курс', 'lesson': 'за занятие',
         'person_course': 'с человека за курс', 'item': ''}


class Conflict(ValueError):
    """Редактор изменял старую ревизию — чужие изменения нельзя затирать."""


@dataclass(frozen=True)
class Price:
    service_id: str
    name: str
    amount_minor: int
    currency: str
    unit: str
    source_ref: str
    verified_at: str
    valid_until: str

    def validate(self):
        check_id(self.service_id)
        if type(self.amount_minor) is not int or not 0 <= self.amount_minor <= 100_000_000:
            raise ValueError('invalid_amount')
        if self.currency != 'GEL' or self.unit not in UNITS:
            raise ValueError('invalid_currency_or_unit')
        for value in (self.name, self.source_ref):
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise ValueError('invalid_text')
        if date.fromisoformat(self.verified_at) > date.fromisoformat(self.valid_until):
            raise ValueError('invalid_validity')


def check_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', value):
        raise ValueError('invalid_service_id')


def today_tbilisi():
    return datetime.now(ZoneInfo('Asia/Tbilisi')).date()


class Catalog:
    """Общий источник фактов. Авторизацию будущий HTTP-слой проверяет до записи."""

    def __init__(self, path):
        self.path = str(path)
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS facts (
                    kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
                    revision INTEGER NOT NULL, PRIMARY KEY(kind, id));
                CREATE TABLE IF NOT EXISTS history (
                    seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL,
                    actor TEXT NOT NULL, changed_at TEXT NOT NULL,
                    old_payload TEXT, new_payload TEXT NOT NULL, revision INTEGER NOT NULL);
            ''')

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def _save(self, kind, key, data, expected_revision, actor):
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError('invalid_revision')
        if not isinstance(actor, str) or not actor.strip() or len(actor) > 254:
            raise ValueError('invalid_actor')
        payload = json.dumps(data, ensure_ascii=False, sort_keys=True)
        with self._connect() as db:
            # Проверка версии и запись должны быть одной транзакцией для двух редакторов.
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT payload, revision FROM facts WHERE kind=? AND id=?', (kind, key)).fetchone()
            revision = old[1] if old else 0
            if revision != expected_revision:
                raise Conflict('revision_conflict')
            revision += 1
            db.execute('INSERT INTO facts VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision',
                       (kind, key, payload, revision))
            db.execute('INSERT INTO history(kind,id,actor,changed_at,old_payload,new_payload,revision) VALUES(?,?,?,?,?,?,?)',
                       (kind, key, actor, datetime.now(ZoneInfo('UTC')).isoformat(), old[0] if old else None, payload, revision))
        return {'revision': revision}

    def save_price(self, price, *, expected_revision, actor):
        price.validate()
        return self._save('price', price.service_id, asdict(price), expected_revision, actor)

    def save_group(self, service_id, start_date, status, *, expected_revision, actor):
        check_id(service_id)
        if status not in ('unknown', 'planned', 'confirmed', 'full'):
            raise ValueError('invalid_status')
        if status == 'unknown':
            if start_date is not None:
                raise ValueError('unknown_has_date')
        else:
            date.fromisoformat(start_date)
        return self._save('group', service_id, {'service_id': service_id, 'start_date': start_date,
                         'status': status}, expected_revision, actor)

    def _get(self, kind, key):
        check_id(key)
        with self._connect() as db:
            row = db.execute('SELECT payload, revision FROM facts WHERE kind=? AND id=?', (kind, key)).fetchone()
        return (json.loads(row[0]), row[1]) if row else (None, None)

    def get_school_info(self, service_id, *, today=None):
        data, revision = self._get('price', service_id)
        if data is None:
            return {'status': 'unknown'}
        Price(**data).validate()
        day = today or today_tbilisi()
        if not date.fromisoformat(data['verified_at']) <= day <= date.fromisoformat(data['valid_until']):
            return {'status': 'stale'}
        return {'status': 'success', 'data': data, 'revision': revision}

    def get_available_dates(self, service_id, *, today=None):
        data, revision = self._get('group', service_id)
        if data is None or data['status'] == 'unknown':
            return {'status': 'unknown'}
        if date.fromisoformat(data['start_date']) < (today or today_tbilisi()):
            return {'status': 'stale'}
        return {'status': data['status'], 'data': data, 'revision': revision}

    def history(self):
        with self._connect() as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute('SELECT * FROM history ORDER BY seq')]

    def services(self):
        with self._connect() as db:
            rows = db.execute("SELECT id,payload FROM facts WHERE kind='price' ORDER BY id").fetchall()
        return [{'service_id': key, 'name': json.loads(payload)['name']} for key, payload in rows]

    def admin_snapshot(self):
        """Админка получает payload вместе с revision для optimistic concurrency."""
        with self._connect() as db:
            rows = db.execute('SELECT kind,id,payload,revision FROM facts ORDER BY kind,id').fetchall()
        result = {'prices': [], 'groups': []}
        for kind, key, payload, revision in rows:
            item = {**json.loads(payload), 'revision': revision}
            result['prices' if kind == 'price' else 'groups'].append(item)
        return result


def validate_price(draft, source):
    fields = ('service_id', 'amount_minor', 'currency', 'unit')
    if not isinstance(draft, dict) or set(draft) != set(fields):
        return ['unexpected_fields']
    if source.get('status') != 'success':
        return ['source_unavailable']
    return [f'mismatch:{key}' for key in fields
            if type(draft[key]) is not type(source['data'][key]) or draft[key] != source['data'][key]]


def render_price(source):
    if source.get('status') != 'success':
        return CONTACT
    p = Price(**source['data'])
    p.validate()
    whole, fraction = divmod(p.amount_minor, 100)
    amount = str(whole) + (f',{fraction:02d}' if fraction else '')
    suffix = (' ' + UNITS[p.unit]) if UNITS[p.unit] else ''
    return f'{p.name} — {amount} ₾{suffix}.'


def render_group(source):
    status = source.get('status')
    if status not in ('planned', 'confirmed', 'full'):
        return 'Дату ближайшей группы уточняем. ' + CONTACT
    day = date.fromisoformat(source['data']['start_date']).strftime('%d.%m.%Y')
    if status == 'planned':
        return f'Планируем старт {day}. Дата зависит от формирования группы и может измениться. ' + CONTACT
    if status == 'full':
        return f'В группе со стартом {day} мест нет. ' + CONTACT
    return f'Старт ближайшей группы подтверждён: {day}. ' + CONTACT
