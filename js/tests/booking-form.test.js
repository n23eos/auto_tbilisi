import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdempotencyKey, normalizePhone, postBooking} from '../booking-form.js';

test('телефон нормализуется только из международного формата', () => {
  assert.equal(normalizePhone('+995 599 12-34-56'), '+995599123456');
  assert.equal(normalizePhone('599123456'), null);
  assert.equal(normalizePhone('+123'), null);
});

test('idempotency key содержит не менее 128 случайных бит', () => {
  const fakeCrypto = {getRandomValues(bytes) { bytes.forEach((_, index) => { bytes[index] = index; }); return bytes; }};
  assert.equal(createIdempotencyKey(fakeCrypto), '000102030405060708090a0b0c0d0e0f');
});

test('сетевой повтор может использовать тот же key и новое решение CAPTCHA', async () => {
  const calls = [];
  const business = {
    group_id: 'group-1', group_revision: 2, name: 'Анна', phone: '+995599123456',
    consent_version: 'v1', consent: true, source: 'site_form',
  };
  const key = '0123456789abcdef0123456789abcdef';
  await assert.rejects(postBooking('https://booking.example', {...business, turnstile_token: 'first'}, key, {
    fetchImpl: async (url, options) => { calls.push({url, options}); throw new TypeError('network'); },
  }), /network/);
  const result = await postBooking('https://booking.example', {...business, turnstile_token: 'second'}, key, {
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify({reference: 'A-1', status: 'pending'}), {status: 200});
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.options.headers['Idempotency-Key']), [key, key]);
  const bodies = calls.map(call => JSON.parse(call.options.body));
  assert.equal(bodies[0].turnstile_token, 'first');
  assert.equal(bodies[1].turnstile_token, 'second');
  assert.deepEqual({...bodies[0], turnstile_token: undefined}, {...bodies[1], turnstile_token: undefined});
});

test('booking POST не отправляет поля вне contract body', async () => {
  let request;
  await postBooking('https://booking.example/', {
    group_id: 'group-1', group_revision: 2, name: 'Анна', phone: '+995599123456',
    consent_version: 'v1', consent: true, source: 'site_chat', turnstile_token: 'token',
  }, '0123456789abcdef0123456789abcdef', {
    fetchImpl: async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({reference: 'A-1'}), {status: 201});
    },
  });
  assert.equal(request.url, 'https://booking.example/api/v1/bookings');
  assert.deepEqual(Object.keys(JSON.parse(request.options.body)).sort(), [
    'consent', 'consent_version', 'group_id', 'group_revision', 'name', 'phone', 'source', 'turnstile_token',
  ]);
});
