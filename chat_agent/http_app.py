"""WSGI API публичного чата и закрытой админки."""

from collections import deque
from datetime import date
from http import HTTPStatus
from http.cookies import SimpleCookie
import json
import ipaddress
from pathlib import Path
import re
import secrets
import threading
import time

from chat_agent.access import AccessDenied
from chat_agent.facts import CONTACT, Conflict, Price, today_tbilisi

STATIC = Path(__file__).with_name('static')
ADMIN_PRICE = re.compile(r'/api/admin/prices/([a-z][a-z0-9_]{0,63})\Z')
ADMIN_GROUP = re.compile(r'/api/admin/groups/([a-z][a-z0-9_]{0,63})\Z')


class Limits:
    """Один процесс, ограниченная память; proxy-заголовкам от клиента не доверяем."""
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = deque()
        self.active = threading.BoundedSemaphore(4)

    def allow(self, address):
        now = time.monotonic()
        with self.lock:
            while self.requests and self.requests[0][0] <= now - 60:
                self.requests.popleft()
            if len(self.requests) >= 60 or sum(ip == address for _, ip in self.requests) >= 6:
                return False
            self.requests.append((now, address))
            return True


def client_address(environ):
    remote = environ.get('REMOTE_ADDR', 'unknown')
    # Gunicorn слушает только loopback: последний адрес добавляет локальный HTTPS-proxy.
    # Первый XFF контролирует посетитель и не годится для ограничения расходов.
    if remote in ('127.0.0.1', '::1') and environ.get('HTTP_X_FORWARDED_FOR'):
        candidate = environ['HTTP_X_FORWARDED_FOR'].split(',')[-1].strip()
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            return remote
    return remote


class Application:
    def __init__(self, harness, origins=('https://avtoshkola.ge', 'https://www.avtoshkola.ge'),
                 *, access=None, admin_origin='https://admin.avtoshkola.ge'):
        self.harness = harness
        self.origins = frozenset(origins)
        self.access = access
        self.admin_origin = admin_origin.rstrip('/')
        self.limits = Limits()

    def _read_json(self, environ, maximum=20000):
        if environ.get('CONTENT_TYPE', '').split(';')[0].strip().lower() != 'application/json':
            raise ValueError('json_required')
        try:
            size = int(environ.get('CONTENT_LENGTH', ''))
        except ValueError as error:
            raise ValueError('length_required') from error
        if not 1 <= size <= maximum:
            raise ValueError('body_limit')
        raw = environ['wsgi.input'].read(size)
        if len(raw) != size:
            raise ValueError('incomplete_body')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise ValueError('invalid_json') from error

    @staticmethod
    def _bytes(start_response, headers, status, body):
        start_response(f'{status} {HTTPStatus(status).phrase}', headers + [('Content-Length', str(len(body)))])
        return [body]

    def _json(self, start_response, headers, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode('utf-8')
        return self._bytes(start_response, headers + [('Content-Type', 'application/json; charset=utf-8')], status, encoded)

    def _admin(self, environ, start_response, headers):
        if self.access is None:
            return self._json(start_response, headers, 404, {'error': 'not_found'})
        try:
            actor = self.access.authorize(environ)
        except AccessDenied:
            return self._json(start_response, headers, 401, {'error': 'access_required'})
        path, method = environ.get('PATH_INFO'), environ.get('REQUEST_METHOD')
        if path == '/admin/' and method == 'GET':
            csrf = secrets.token_urlsafe(32)
            admin_headers = headers + [
                ('Content-Type', 'text/html; charset=utf-8'),
                ('Set-Cookie', f'chat_admin_csrf={csrf}; Path=/; Secure; SameSite=Strict; Max-Age=3600'),
                ('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")]
            return self._bytes(start_response, admin_headers, 200, (STATIC/'admin.html').read_bytes())
        assets = {'/admin/admin.css': ('text/css; charset=utf-8', 'admin.css'),
                  '/admin/admin.js': ('text/javascript; charset=utf-8', 'admin.js')}
        if path in assets and method == 'GET':
            kind, filename = assets[path]
            return self._bytes(start_response, headers + [('Content-Type', kind)], 200, (STATIC/filename).read_bytes())
        if path == '/api/admin/catalog' and method == 'GET':
            return self._json(start_response, headers, 200, {**self.harness.catalog.admin_snapshot(), 'actor': actor})
        price_match, group_match = ADMIN_PRICE.fullmatch(path or ''), ADMIN_GROUP.fullmatch(path or '')
        if method != 'PUT' or not (price_match or group_match):
            return self._json(start_response, headers, 404, {'error': 'not_found'})
        if environ.get('HTTP_ORIGIN', '').rstrip('/') != self.admin_origin:
            return self._json(start_response, headers, 403, {'error': 'origin_not_allowed'})
        cookie = SimpleCookie(environ.get('HTTP_COOKIE', ''))
        expected_csrf = cookie.get('chat_admin_csrf')
        if not expected_csrf or not expected_csrf.value or not secrets.compare_digest(expected_csrf.value, environ.get('HTTP_X_CSRF_TOKEN', '')):
            return self._json(start_response, headers, 403, {'error': 'csrf'})
        try:
            data = self._read_json(environ, 4000)
            if not isinstance(data, dict):
                raise ValueError('invalid_body')
            if price_match:
                if set(data) != {'amount_minor', 'valid_until', 'expected_revision'}:
                    raise ValueError('invalid_fields')
                current = next((p for p in self.harness.catalog.admin_snapshot()['prices'] if p['service_id'] == price_match[1]), None)
                if current is None or type(data['amount_minor']) is not int:
                    raise ValueError('invalid_price')
                date.fromisoformat(data['valid_until'])
                price = Price(price_match[1], current['name'], data['amount_minor'], current['currency'],
                    current['unit'], 'admin', today_tbilisi().isoformat(), data['valid_until'])
                result = self.harness.catalog.save_price(price, expected_revision=data['expected_revision'], actor=actor)
            else:
                if set(data) != {'status', 'start_date', 'expected_revision'}:
                    raise ValueError('invalid_fields')
                if group_match[1] not in {s['service_id'] for s in self.harness.catalog.services()}:
                    raise ValueError('unknown_service')
                result = self.harness.catalog.save_group(group_match[1], data['start_date'], data['status'],
                    expected_revision=data['expected_revision'], actor=actor)
            return self._json(start_response, headers, 200, result)
        except Conflict:
            return self._json(start_response, headers, 409, {'error': 'revision_conflict'})
        except (ValueError, KeyError, TypeError):
            return self._json(start_response, headers, 400, {'error': 'invalid_body'})
        except Exception:
            return self._json(start_response, headers, 503, {'error': 'unavailable'})

    def __call__(self, environ, start_response):
        origin = environ.get('HTTP_ORIGIN', '')
        headers = [('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                   ('Referrer-Policy', 'no-referrer'), ('Vary', 'Origin')]
        if origin in self.origins:
            headers.append(('Access-Control-Allow-Origin', origin))
        path, method = environ.get('PATH_INFO'), environ.get('REQUEST_METHOD')
        if path == '/health' and method == 'GET':
            return self._json(start_response, headers, 200, {'status': 'ok'})
        if path == '/admin/' or (path or '').startswith('/admin/') or (path or '').startswith('/api/admin/'):
            return self._admin(environ, start_response, headers)
        if path not in ('/api/chat', '/api/catalog'):
            return self._json(start_response, headers, 404, {'error': 'not_found'})
        if origin not in self.origins:
            return self._json(start_response, headers, 403, {'error': 'origin_not_allowed'})
        if method == 'OPTIONS':
            headers.extend([('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
                            ('Access-Control-Allow-Headers', 'Content-Type')])
            if environ.get('HTTP_ACCESS_CONTROL_REQUEST_PRIVATE_NETWORK') == 'true':
                headers.append(('Access-Control-Allow-Private-Network', 'true'))
            return self._json(start_response, headers, 200, {})
        if path == '/api/catalog' and method == 'GET':
            try:
                items = []
                for service in self.harness.catalog.services():
                    price = self.harness.catalog.get_school_info(service['service_id'])
                    item = {**service, 'status': price['status']}
                    if price['status'] == 'success':
                        item.update({key: price['data'][key] for key in ('amount_minor', 'currency', 'unit')})
                    items.append(item)
                return self._json(start_response, headers, 200, {'services': items})
            except Exception:
                return self._json(start_response, headers, 503, {'error': 'unavailable', 'answer': CONTACT})
        if path != '/api/chat' or method != 'POST':
            return self._json(start_response, headers, 405, {'error': 'method_not_allowed'})
        try:
            data = self._read_json(environ)
        except ValueError as error:
            code = {'json_required': 415, 'length_required': 411, 'body_limit': 413}.get(str(error), 400)
            return self._json(start_response, headers, code, {'error': str(error)})
        if not self.limits.allow(client_address(environ)):
            return self._json(start_response, headers, 429, {'error': 'rate_limit', 'answer': 'Слишком много вопросов. Попробуйте через минуту. ' + CONTACT})
        if not self.limits.active.acquire(blocking=False):
            return self._json(start_response, headers, 503, {'error': 'busy', 'answer': CONTACT})
        try:
            if not isinstance(data, dict) or not {'message'} <= set(data) <= {'message', 'history'}:
                return self._json(start_response, headers, 400, {'error': 'invalid_body'})
            result = self.harness.run(data['message'], data.get('history'))
            public = {key: result[key] for key in ('status', 'answer', 'run_id')}
            return self._json(start_response, headers, 400 if result['status'] == 'error' else 200, public)
        except Exception:
            return self._json(start_response, headers, 503, {'error': 'unavailable', 'answer': CONTACT})
        finally:
            self.limits.active.release()
