import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../affiliate-analytics.js', import.meta.url), 'utf8');

function loadAnalytics({ cards = [], gtag, IntersectionObserver } = {}) {
  const listeners = new Map();
  const document = {
    readyState: 'complete',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-affiliate-card]');
      return cards;
    },
  };
  const window = { gtag, IntersectionObserver };

  vm.runInNewContext(source, { document, window });

  return {
    click(target) {
      listeners.get('click')({ target });
    },
    setGtag(handler) {
      window.gtag = handler;
    },
  };
}

test('клик по вложенному элементу отправляет только заданные аналитические параметры', () => {
  const calls = [];
  const link = {
    dataset: { affiliate: 'holafly', placement: 'home_banner', product: 'esim' },
    href: 'https://example.test/private-query?email=user@example.test',
  };
  const span = { closest: selector => selector === 'a[data-affiliate]' ? link : null };
  const analytics = loadAnalytics({ gtag: (...args) => calls.push(args) });

  analytics.click(span);
  analytics.click({
    closest: () => ({ dataset: { affiliate: 'tripcom', placement: 'home_banner' } }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    'event',
    'affiliate_click',
    { affiliate: 'holafly', placement: 'home_banner', product: 'esim' },
  ]]);
  assert.doesNotMatch(JSON.stringify(calls), /private-query|user@example/);
});

test('показ учитывается при видимости не менее 50 процентов', () => {
  const calls = [];
  const card = {
    dataset: { affiliateCard: 'omio', placement: 'home_banner', product: 'transport' },
  };
  let observer;
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      this.unobserved = [];
      observer = this;
    }

    observe(target) { this.observed.push(target); }
    unobserve(target) { this.unobserved.push(target); }
  }

  loadAnalytics({
    cards: [card],
    gtag: (...args) => calls.push(args),
    IntersectionObserver: FakeIntersectionObserver,
  });

  assert.equal(observer.options.threshold, 0.5);
  assert.deepEqual(observer.observed, [card]);
  observer.callback([{ target: card, isIntersecting: true, intersectionRatio: 0.49 }]);
  assert.equal(calls.length, 0);
  observer.callback([{ target: card, isIntersecting: true, intersectionRatio: 0.5 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    'event',
    'affiliate_impression',
    { affiliate: 'omio', placement: 'home_banner' },
  ]]);
  assert.deepEqual(observer.unobserved, [card]);
});

test('повторные пересечения одной карточки не дублируют показ', () => {
  const calls = [];
  const card = {
    dataset: { affiliateCard: 'tripcom', placement: 'home_banner' },
  };
  let callback;
  class FakeIntersectionObserver {
    constructor(handler) { callback = handler; }
    observe() {}
    unobserve() {}
  }

  loadAnalytics({
    cards: [card],
    gtag: (...args) => calls.push(args),
    IntersectionObserver: FakeIntersectionObserver,
  });

  const intersection = { target: card, isIntersecting: true, intersectionRatio: 1 };
  callback([intersection]);
  callback([intersection]);

  assert.equal(calls.length, 1);
});

test('без gtag и IntersectionObserver модуль не мешает клику', () => {
  const link = {
    dataset: { affiliate: 'tripcom', placement: 'home_banner', product: 'flights' },
  };
  const analytics = loadAnalytics();

  assert.doesNotThrow(() => analytics.click({ closest: () => link }));
});

test('показ повторяется на следующем пересечении, если gtag появился позднее', () => {
  const card = {
    dataset: { affiliateCard: 'holafly', placement: 'home_banner' },
  };
  let callback;
  let unobserveCount = 0;
  const calls = [];
  class FakeIntersectionObserver {
    constructor(handler) { callback = handler; }
    observe() {}
    unobserve() { unobserveCount += 1; }
  }

  const analytics = loadAnalytics({ cards: [card], IntersectionObserver: FakeIntersectionObserver });
  const intersection = { target: card, isIntersecting: true, intersectionRatio: 0.5 };

  assert.doesNotThrow(() => callback([intersection]));
  assert.equal(unobserveCount, 0);
  analytics.setGtag((...args) => calls.push(args));
  callback([intersection]);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    'event',
    'affiliate_impression',
    { affiliate: 'holafly', placement: 'home_banner' },
  ]]);
  assert.equal(unobserveCount, 1);
});
