import json

from chat_agent.facts import render_group
from chat_agent.group_client import GroupClient, validate_snapshot


def payload():
    return {
        'schedule_revision': 7,
        'fetched_at': '2026-09-29T12:00:00Z',
        'timezone': 'Asia/Tbilisi',
        'groups': [{
            'id': 'group-1', 'revision': 2, 'start_date': '2026-10-05',
            'start_time': '19:00', 'date_status': 'planned',
            'enrollment_open': True, 'availability': 'open',
        }],
    }


class Response:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return self.body


def test_client_uses_public_endpoint_timeout_and_no_store():
    seen = {}

    def open_fixture(request, timeout):
        seen['url'] = request.full_url
        seen['cache'] = request.headers['Cache-control']
        seen['user_agent'] = request.headers['User-agent']
        seen['timeout'] = timeout
        return Response(json.dumps(payload()).encode())

    result = GroupClient('https://booking.example/', opener=open_fixture).get_available_dates('theory_group')
    assert result['status'] == 'success'
    assert seen == {
        'url': 'https://booking.example/api/v1/groups?service_id=theory_group',
        'cache': 'no-store',
        'user_agent': 'AvtoshkolaGroupReader/1.0',
        'timeout': 3,
    }


def test_error_or_invalid_payload_is_unavailable_without_fallback():
    def broken(*args, **kwargs):
        raise TimeoutError('offline')

    assert GroupClient('https://booking.example', opener=broken).get_available_dates('theory_group') == {
        'status': 'unavailable'}
    bad = payload()
    bad['groups'][0]['start_date'] = '2026-02-30'
    client = GroupClient('https://booking.example', opener=lambda *args, **kwargs:
                         Response(json.dumps(bad).encode()))
    assert client.get_available_dates('theory_group') == {'status': 'unavailable'}


def test_snapshot_strips_unknown_fields_and_renderer_keeps_statuses():
    data = payload()
    data['groups'][0]['student_phone'] = '+995555000000'
    result = validate_snapshot(data)
    assert 'student_phone' not in result['groups'][0]
    answer = render_group(result)
    assert '05.10.2026 в 19:00' in answer
    assert 'дата предварительная' in answer
    assert '599' not in answer


def test_empty_and_unavailable_have_different_messages():
    empty = validate_snapshot({**payload(), 'groups': []})
    assert 'Дату ближайшей группы уточняем' in render_group(empty)
    assert 'временно недоступно' in render_group({'status': 'unavailable'})
