import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPriceCatalog } from '../chat-api.js';

const waitForAbort = signal => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), {once: true});
});

test('каталог возвращает данные и освобождает таймер после успеха', async () => {
  const catalog = {services: [{service_id: 'theory_group', status: 'success', amount_minor: 15000}]};
  let signal;
  const data = await fetchPriceCatalog('https://example.test', {
    timeoutMs: 10,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://example.test/api/catalog');
      assert.equal(options.headers.Accept, 'application/json');
      signal = options.signal;
      return new Response(JSON.stringify(catalog));
    },
  });
  assert.deepEqual(data, catalog);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
});

test('каталог отменяет запрос, если сервер не прислал заголовки', async () => {
  let signal;
  await assert.rejects(fetchPriceCatalog('https://example.test', {
    timeoutMs: 10,
    fetchImpl: (url, options) => {
      signal = options.signal;
      return waitForAbort(signal);
    },
  }), {name: 'AbortError'});
  assert.equal(signal.aborted, true);
});

test('таймаут каталога действует и при зависании тела ответа', async () => {
  await assert.rejects(fetchPriceCatalog('https://example.test', {
    timeoutMs: 10,
    fetchImpl: async (url, {signal}) => ({ok: true, json: () => waitForAbort(signal)}),
  }), {name: 'AbortError'});
});

test('ошибка HTTP передаётся обработчику UI и освобождает таймер', async () => {
  let signal;
  await assert.rejects(fetchPriceCatalog('https://example.test', {
    timeoutMs: 10,
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Response('Unavailable', {status: 503});
    },
  }), /catalog_http_503/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
});

test('некорректный JSON передаётся обработчику UI', async () => {
  await assert.rejects(fetchPriceCatalog('https://example.test', {
    fetchImpl: async () => new Response('not json'),
  }), SyntaxError);
});
