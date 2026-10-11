import {test, expect} from '@playwright/test';

async function prepare(page, context, {storageFailure = false} = {}) {
  const chatCalls = [];
  await page.addInitScript(({failStorage}) => {
    if (!failStorage) return;
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
  }, {failStorage: storageFailure});
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === 'http://127.0.0.1:8881') return route.continue();
    if (url.pathname === '/api/chat') chatCalls.push(request.postDataJSON());
    if (url.pathname === '/api/catalog') return route.fulfill({json: {services: []}});
    if (url.pathname === '/api/v1/groups') return route.fulfill({json: {
      schedule_revision: 1,
      fetched_at: '2026-10-10T00:00:00Z',
      timezone: 'Asia/Tbilisi',
      groups: [],
    }});
    return route.fulfill({status: 200, contentType: 'text/plain', body: ''});
  });
  page.on('pageerror', error => { throw error; });
  return chatCalls;
}

test('сразу открывает полную панель без фокуса и запроса к чату', async ({page, context}) => {
  const chatCalls = await prepare(page, context);
  await page.goto('/');

  await expect(page.locator('#school-chat-panel')).toBeVisible();
  await expect(page.locator('.school-chat__invite')).toHaveCount(0);
  await expect(page.getByLabel('Ваш вопрос', {exact: true})).not.toBeFocused();
  await expect(page.getByRole('button', {name: 'Открыть чат с ботом'})).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('school-chat-invite-seen'))).toBeNull();
  expect(chatCalls).toEqual([]);
});

test('закрытие подавляет повторное автооткрытие в сессии, ручное открытие фокусирует ввод', async ({page, context}) => {
  const chatCalls = await prepare(page, context);
  await page.goto('/');
  await page.getByRole('button', {name: 'Закрыть чат'}).click();

  await expect(page.locator('#school-chat-panel')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Открыть чат с ботом'})).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem('school-chat-invite-seen'))).toBe('1');

  await page.reload();
  await expect(page.locator('#school-chat-panel')).toBeHidden();
  await page.goto('/voprosy/');
  await expect(page.locator('#school-chat-panel')).toBeHidden();

  await page.getByRole('button', {name: 'Открыть чат с ботом'}).click();
  await expect(page.locator('#school-chat-panel')).toBeVisible();
  await expect(page.getByLabel('Ваш вопрос', {exact: true})).toBeFocused();
  expect(chatCalls).toEqual([]);
});

test('ошибки sessionStorage не ломают автооткрытие и ручной чат', async ({page, context}) => {
  const chatCalls = await prepare(page, context, {storageFailure: true});
  await page.goto('/');
  await expect(page.locator('#school-chat-panel')).toBeVisible();
  await expect(page.getByLabel('Ваш вопрос', {exact: true})).not.toBeFocused();

  await page.getByRole('button', {name: 'Закрыть чат'}).click();
  await expect(page.locator('#school-chat-panel')).toBeHidden();
  await page.getByRole('button', {name: 'Открыть чат с ботом'}).click();
  await expect(page.getByLabel('Ваш вопрос', {exact: true})).toBeFocused();
  expect(chatCalls).toEqual([]);
});

for (const path of ['/bilety/trenirovka/', '/bilety/ekzamen/']) {
  test(`не добавляет чат на странице ${path}`, async ({page, context}) => {
    await prepare(page, context);
    await page.goto(path);
    await expect(page.locator('.school-chat')).toHaveCount(0);
  });
}
