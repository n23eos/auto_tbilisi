"""Единственный сетевой путь к DeepSeek; никаких произвольных URL от модели."""

from datetime import date, datetime
import http.client
import json
import math
import sqlite3
import time
import uuid
from zoneinfo import ZoneInfo

MODEL = 'deepseek-flash'
RATE_DATE = '2026-09-12'
RATE_VALID_UNTIL = date(2026, 10, 12)
# Верхние peak/cache-miss ставки USD за миллион токенов, проверены в официальной документации.
INPUT_RATE = 0.3
OUTPUT_RATE = 1.2
MAX_OUTPUT = 1200


class ProviderError(RuntimeError):
    pass


class BudgetExceeded(ProviderError):
    pass


class Budget:
    def __init__(self, path, limit_micro=5_000_000):
        if type(limit_micro) is not int or not 0 < limit_micro <= 5_000_000:
            raise ValueError('invalid_budget')
        self.path, self.limit = str(path), limit_micro
        db = sqlite3.connect(self.path)
        try:
            with db:
                db.execute('CREATE TABLE IF NOT EXISTS api_budget(id TEXT PRIMARY KEY, month TEXT, reserved INTEGER, charged INTEGER, settled INTEGER DEFAULT 0)')
        finally:
            db.close()

    def reserve(self, amount):
        if type(amount) is not int or amount <= 0:
            raise ValueError('invalid_reservation')
        month = datetime.now(ZoneInfo('Asia/Tbilisi')).strftime('%Y-%m')
        key = uuid.uuid4().hex
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                used = db.execute('SELECT coalesce(sum(charged),0) FROM api_budget WHERE month=?', (month,)).fetchone()[0]
                if used + amount > self.limit:
                    raise BudgetExceeded('monthly_budget')
                # Незавершённый/неоднозначный запрос сохраняет весь резерв даже после падения процесса.
                db.execute('INSERT INTO api_budget VALUES(?,?,?,?,0)', (key, month, amount, amount))
        finally:
            db.close()
        return key

    def settle(self, key, amount):
        if type(amount) is not int or amount < 0:
            raise ValueError('invalid_charge')
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                row = db.execute('SELECT reserved FROM api_budget WHERE id=?', (key,)).fetchone()
                if row is None or amount > row[0]:
                    raise ProviderError('usage_exceeds_reservation')
                db.execute('UPDATE api_budget SET charged=?, settled=1 WHERE id=? AND settled=0', (amount, key))
        finally:
            db.close()


class DeepSeek:
    def __init__(self, key, budget, transport=None):
        if not key or key.strip() in ('ВАШ_КЛЮЧ', 'your_key'):
            raise ValueError('missing_api_key')
        self._key, self.budget = key.strip(), budget
        self.transport = transport or self._request

    def complete(self, messages, tools, *, deadline):
        if datetime.now(ZoneInfo('Asia/Tbilisi')).date() > RATE_VALID_UNTIL:
            raise ProviderError('pricing_requires_review')
        body = {'model': MODEL, 'thinking': {'type': 'disabled'}, 'messages': messages,
                'max_tokens': MAX_OUTPUT, 'stream': False, 'tools': tools}
        encoded = json.dumps(body, ensure_ascii=False).encode()
        if len(encoded) > 60000:
            raise ProviderError('context_limit')
        # UTF-8 bytes с большим запасом на служебную токенизацию вместо неточной char/4 оценки.
        reserved = math.ceil((len(encoded) * 2 + 4096) * INPUT_RATE + MAX_OUTPUT * OUTPUT_RATE)
        if deadline <= time.monotonic():
            raise ProviderError('deadline')
        ticket = self.budget.reserve(reserved)
        result = self.transport(body, min(deadline, time.monotonic() + 10))
        usage = result.get('usage', {})
        prompt, output = usage.get('prompt_tokens'), usage.get('completion_tokens')
        if any(type(n) is not int or n < 0 for n in (prompt, output)):
            raise ProviderError('invalid_usage')
        charge = math.ceil(prompt * INPUT_RATE + output * OUTPUT_RATE)
        self.budget.settle(ticket, charge)
        choices = result.get('choices')
        if not isinstance(choices, list) or len(choices) != 1:
            raise ProviderError('invalid_choices')
        choice = choices[0]
        if choice.get('finish_reason') not in ('stop', 'tool_calls'):
            raise ProviderError('incomplete_response')
        message = choice.get('message')
        if not isinstance(message, dict) or message.get('role') != 'assistant':
            raise ProviderError('invalid_message')
        if message.get('reasoning_content') or usage.get('completion_tokens_details', {}).get('reasoning_tokens', 0):
            raise ProviderError('unexpected_thinking')
        return message, {'prompt_tokens': prompt, 'completion_tokens': output,
                         'cost_upper_micro_usd': charge, 'pricing_date': RATE_DATE,
                         'model': result.get('model', MODEL)}

    def _request(self, body, deadline):
        connection = http.client.HTTPSConnection('api.deepseek.com', timeout=max(.1, deadline-time.monotonic()))
        try:
            connection.request('POST', '/chat/completions', json.dumps(body).encode(),
                {'Authorization': 'Bearer ' + self._key, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                raise ProviderError(f'provider_http_{response.status}')
            data = bytearray()
            while True:
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise ProviderError('deadline')
                if connection.sock:
                    connection.sock.settimeout(remaining)
                chunk = response.read1(8192)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 256000:
                    raise ProviderError('response_limit')
            return json.loads(data)
        except (OSError, http.client.HTTPException, ValueError) as error:
            raise ProviderError('provider_transport') from error
        finally:
            connection.close()
