import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

const indexSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

async function prepare(page, context, {analytics = false, storageFailure = false, hidden = false} = {}) {
  const chatCalls = [];
  await page.clock.install();
  await page.addInitScript(({analyticsEnabled, failStorage, startsHidden}) => {
    if (analyticsEnabled) {
      window.__inviteEvents = [];
      window.gtag = (...args) => window.__inviteEvents.push(args);
    }
    if (failStorage) {
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key === 'school-chat-invite-seen') throw new Error('storage blocked');
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === 'school-chat-invite-seen') throw new Error('storage blocked');
        return setItem.call(this, key, value);
      };
    }
    let isHidden = startsHidden;
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => isHidden});
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => isHidden ? 'hidden' : 'visible',
    });
    window.__setTestHidden = value => {
      isHidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  }, {analyticsEnabled: analytics, failStorage: storageFailure, startsHidden: hidden});
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === 'http://127.0.0.1:8881') return route.continue();
    if (url.pathname === '/api/chat') chatCalls.push(request.postDataJSON());
    if (url.pathname === '/api/catalog') return route.fulfill({json: {services: []}});
    if (url.pathname === '/api/v1/groups') return route.fulfill({json: {
      schedule_revision: 1,
      fetched_at: '2026-10-07T00:00:00Z',
      timezone: 'Asia/Tbilisi',
      groups: [],
    }});
    return route.fulfill({status: 200, contentType: 'text/plain', body: ''});
  });
  page.on('pageerror', error => { throw error; });
  return chatCalls;
}

async function openHomeWithoutBooking(page) {
  await page.route('http://127.0.0.1:8881/', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: indexSource
      .replace(/data-booking-api="[^"]*"/, 'data-booking-api=""')
      .replace(/data-turnstile-sitekey="[^"]*"/, 'data-turnstile-sitekey=""'),
  }));
  await page.goto('/');
}

test('через 30 секунд показывает приглашение без панели, фокуса, звука и запроса к чату', async ({page, context}) => {
  const chatCalls = await prepare(page, context, {analytics: true});
  await page.goto('/');
  const invite = page.getByRole('region', {name: 'Приглашение от бота автошколы'});
  const panel = page.locator('#school-chat-panel');

  await page.clock.fastForward(29000);
  await expect(invite).toBeHidden();
  await page.clock.fastForward(1100);
  await expect(invite).toBeVisible();
  await expect(invite.getByText('Бот автошколы', {exact: true})).toBeVisible();
  await expect(invite.getByText('Подсказать по обучению или правам в Грузии?', {exact: true})).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(page.getByLabel('Ваш вопрос', {exact: true})).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect(chatCalls).toEqual([]);
  expect(await page.evaluate(() => window.__inviteEvents)).toEqual([
    ['event', 'chat_invite_view'],
  ]);
  expect(await page.evaluate(() => sessionStorage.getItem('school-chat-invite-seen'))).toBe('1');

  const box = await invite.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await invite.getByRole('button', {name: 'Задать вопрос'}).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Ваш вопрос', {exact: true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', {name: 'Открыть чат с ботом'})).toBeFocused();
  expect(await page.evaluate(() => window.__inviteEvents)).toEqual([
    ['event', 'chat_invite_view'],
    ['event', 'chat_invite_open'],
  ]);
  expect(chatCalls).toEqual([]);
});

test('закрытие с клавиатуры возвращает фокус и исключает повтор на главной и FAQ', async ({page, context}) => {
  await prepare(page, context, {analytics: true});
  await page.goto('/');
  await page.clock.fastForward(30000);
  const invite = page.getByRole('region', {name: 'Приглашение от бота автошколы'});
  await invite.getByRole('button', {name: 'Закрыть приглашение'}).focus();
  await page.keyboard.press('Enter');
  await expect(invite).toBeHidden();
  await expect(page.getByRole('button', {name: 'Открыть чат с ботом'})).toBeFocused();
  expect(await page.evaluate(() => window.__inviteEvents)).toEqual([
    ['event', 'chat_invite_view'],
    ['event', 'chat_invite_dismiss'],
  ]);

  await page.reload();
  await page.clock.fastForward(60000);
  await expect(invite).toBeHidden();
  await page.goto('/voprosy/');
  await page.clock.fastForward(60000);
  await expect(page.locator('.school-chat__invite')).toBeHidden();
});

test('ручное открытие до таймера отменяет приглашение', async ({page, context}) => {
  const chatCalls = await prepare(page, context);
  await page.goto('/');
  const toggle = page.getByRole('button', {name: 'Открыть чат с ботом'});
  await toggle.click();
  await expect(page.locator('#school-chat-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.clock.fastForward(60000);
  await expect(page.locator('.school-chat__invite')).toBeHidden();
  expect(chatCalls).toEqual([]);
});

test('таймер приостанавливается, если вкладка скрыта в середине отсчёта', async ({page, context}) => {
  await prepare(page, context);
  await page.goto('/');
  const invite = page.locator('.school-chat__invite');
  await page.clock.fastForward(10000);
  await page.evaluate(() => window.__setTestHidden(true));
  await page.clock.fastForward(60000);
  await expect(invite).toBeHidden();
  await page.evaluate(() => window.__setTestHidden(false));
  await page.clock.fastForward(19000);
  await expect(invite).toBeHidden();
  await page.clock.fastForward(1100);
  await expect(invite).toBeVisible();
});

test('после истечения задержки ждёт завершения ввода в форме', async ({page, context}) => {
  await prepare(page, context);
  await openHomeWithoutBooking(page);
  const comment = page.locator('#cb-comment');
  await comment.focus();
  await comment.fill('Уточняю вопрос');
  await page.clock.fastForward(30000);
  await expect(page.locator('.school-chat__invite')).toBeHidden();
  await comment.blur();
  await page.clock.runFor(1);
  await expect(page.locator('.school-chat__invite')).toBeVisible();
});

for (const closeMethod of ['Escape', 'клик снаружи']) {
test(`после истечения задержки ждёт закрытия меню контактов: ${closeMethod}`, async ({page, context}) => {
  await prepare(page, context);
  await page.goto('/voprosy/');
  const contacts = page.getByRole('button', {name: 'Связаться с нами'});
  await contacts.click();
  await expect(contacts).toHaveAttribute('aria-expanded', 'true');
  await page.clock.fastForward(30000);
  await expect(page.locator('.school-chat__invite')).toBeHidden();
  if (closeMethod === 'Escape') await page.keyboard.press('Escape');
  else await page.getByRole('heading', {level: 1}).click();
  await expect(contacts).toHaveAttribute('aria-expanded', 'false');
  await page.clock.runFor(1);
  await expect(page.locator('.school-chat__invite')).toBeVisible();
});
}

test('ошибки sessionStorage не ломают приглашение и ручной чат', async ({page, context}) => {
  await prepare(page, context, {storageFailure: true});
  await page.goto('/');
  const invite = page.locator('.school-chat__invite');
  await page.clock.fastForward(30000);
  await expect(invite).toBeVisible();
  await page.getByRole('button', {name: 'Закрыть приглашение'}).click();
  await page.clock.fastForward(60000);
  await expect(invite).toBeHidden();
  await page.getByRole('button', {name: 'Открыть чат с ботом'}).click();
  await expect(page.locator('#school-chat-panel')).toBeVisible();
});

test('на страницах экзамена виджет и приглашение не добавляются', async ({page, context}) => {
  await prepare(page, context);
  await page.goto('/bilety/ekzamen/');
  await page.clock.fastForward(60000);
  await expect(page.locator('.school-chat')).toHaveCount(0);
});
