"""Read-only client for the canonical public group schedule."""

from datetime import date, datetime
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}\Z')
TIME_RE = re.compile(r'(\d{2}):(\d{2})\Z')
USER_AGENT = 'AvtoshkolaGroupReader/1.0'


def _valid_date(value):
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _valid_time(value):
    match = TIME_RE.fullmatch(value) if isinstance(value, str) else None
    return bool(match and int(match[1]) < 24 and int(match[2]) < 60)


def validate_snapshot(payload):
    if not isinstance(payload, dict):
        raise ValueError('invalid_groups_payload')
    if type(payload.get('schedule_revision')) is not int or payload['schedule_revision'] < 0:
        raise ValueError('invalid_schedule_revision')
    if payload.get('timezone') != 'Asia/Tbilisi':
        raise ValueError('invalid_timezone')
    fetched_at = payload.get('fetched_at')
    if not isinstance(fetched_at, str):
        raise ValueError('invalid_fetched_at')
    try:
        datetime.fromisoformat(fetched_at.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError('invalid_fetched_at') from error
    groups = payload.get('groups')
    if not isinstance(groups, list) or len(groups) > 3:
        raise ValueError('invalid_groups')
    clean = []
    for item in groups:
        if (not isinstance(item, dict)
                or not isinstance(item.get('id'), str) or not 0 < len(item['id']) <= 128
                or type(item.get('revision')) is not int or item['revision'] < 1
                or not _valid_date(item.get('start_date'))
                or not _valid_time(item.get('start_time'))
                or item.get('date_status') not in ('planned', 'confirmed')
                or type(item.get('enrollment_open')) is not bool
                or item.get('availability') not in ('open', 'full', 'closed')):
            raise ValueError('invalid_group')
        clean.append({key: item[key] for key in (
            'id', 'revision', 'start_date', 'start_time', 'date_status',
            'enrollment_open', 'availability')})
    keys = [f"{item['start_date']}T{item['start_time']}" for item in clean]
    if keys != sorted(keys):
        raise ValueError('unsorted_groups')
    return {'status': 'success', 'schedule_revision': payload['schedule_revision'],
            'fetched_at': fetched_at, 'timezone': 'Asia/Tbilisi', 'groups': clean}


class GroupClient:
    """Fetch each answer from the shared source; stale data is never cached."""

    is_shared = True

    def __init__(self, base_url, *, opener=urlopen, timeout=3):
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError('booking_api_missing')
        self.base_url = base_url.rstrip('/')
        self.opener = opener
        self.timeout = timeout

    def get_available_dates(self, service_id):
        url = self.base_url + '/api/v1/groups?' + urlencode({'service_id': service_id})
        request = Request(url, headers={'Accept': 'application/json',
                                        'Cache-Control': 'no-store',
                                        'User-Agent': USER_AGENT})
        try:
            with self.opener(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise ValueError('groups_http_error')
                payload = json.loads(response.read().decode('utf-8'))
            return validate_snapshot(payload)
        except (HTTPError, URLError, OSError, TimeoutError, ValueError,
                UnicodeError, json.JSONDecodeError):
            return {'status': 'unavailable'}


class CatalogGroupAdapter:
    """Compatibility for local tools and old tests before configured cutover."""

    is_shared = False

    def __init__(self, catalog):
        self.catalog = catalog

    def get_available_dates(self, service_id):
        return self.catalog.get_available_dates(service_id)
