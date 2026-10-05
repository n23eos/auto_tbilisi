import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const faqSource = readFileSync(new URL('../../voprosy/index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../js/main.js', import.meta.url), 'utf8');

function withBookingFixture(html) {
  return html
    .replace(/data-booking-api="[^"]*"/, 'data-booking-api="https://booking.test"')
    .replace(/data-turnstile-sitekey="[^"]*"/, 'data-turnstile-sitekey="fixture-sitekey"');
}

function group({revision = 2, date = '2026-10-05', availability = 'open', enrollmentOpen = true} = {}) {
  return {
    id: 'group-1', revision, start_date: date, start_time: '19:00',
    date_status: 'planned', enrollment_open: enrollmentOpen, availability,
  };
}

async function bookingFixture(context) {
  const state = {
    group: group(),
    groups: null,
    groupsFail: false,
    bookingCalls: [],
    chatCalls: [],
    externalCalls: [],
    bookingMode: 'success',
  };
  await context.route(/^http:\/\/127\.0\.0\.1:8881\/(?:\?.*)?$/, route => {
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: withBookingFixture(source)});
  });
  await context.route('http://127.0.0.1:8881/voprosy/', route => {
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: withBookingFixture(faqSource)});
  });
  await context.route('https://booking.test/api/v1/groups**', route => {
    if (state.groupsFail) return route.fulfill({status: 503, json: {error: 'unavailable'}});
    return route.fulfill({
      headers: {'Cache-Control': 'no-store'},
      json: {
        schedule_revision: state.group.revision,
        fetched_at: '2026-09-29T12:00:00Z',
        timezone: 'Asia/Tbilisi',
        groups: state.groups ?? [state.group],
      },
    });
  });
  await context.route('https://booking.test/api/v1/bookings', async route => {
    state.bookingCalls.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (state.bookingMode === 'network-then-change') {
      if (state.bookingCalls.length === 1) return route.abort('connectionreset');
      if (state.bookingCalls.length === 2) {
        state.group = group({revision: 3, date: '2026-10-12'});
        return route.fulfill({status: 409, json: {error: 'group_changed', group: state.group}});
      }
    }
    return route.fulfill({
      status: 201,
      json: {
        reference: 'GR-TEST-1', status: 'pending',
        message: 'Заявка принята. Ожидает подтверждения администратора',
        contact_method: 'phone',
      },
    });
  });
  await context.route('https://challenges.cloudflare.com/turnstile/**', route => route.fulfill({
    contentType: 'text/javascript',
    body: `(() => {
      let sequence = 0;
      const widgets = new Map();
      window.turnstile = {
        render(node, options) {
          const id = ++sequence;
          widgets.set(id, options);
          node.textContent = 'Проверка пройдена';
          options.callback('fixture-turnstile-' + id);
          return id;
        },
        reset(id) {
          widgets.get(id).callback('fixture-turnstile-' + id + '-retry-' + (++sequence));
        }
      };
    })();`,
  }));
  await context.route('https://vps-apds.tail9c66b0.ts.net:10000/**', route => {
    if (route.request().url().endsWith('/api/catalog')) return route.fulfill({json: {services: []}});
    state.chatCalls.push(route.request().postDataJSON());
    return route.fulfill({status: 503, json: {error: 'unavailable'}});
  });
  await context.route('https://formsubmit.co/**', route => {
    state.externalCalls.push(route.request().url());
    return route.fulfill({status: 500, json: {error: 'blocked_by_test'}});
  });
  return state;
}

test.beforeEach(async ({page}) => {
  page.on('pageerror', error => { throw error; });
});

test('показывает актуальную группу и очищает ее после ошибки источника', async ({page, context}) => {
  const state = await bookingFixture(context);
  await page.goto('/');
  const region = page.getByRole('region', {name: 'Выберите дату старта'});
  await expect(region.getByText('5 октября 2026 г., 19:00')).toBeVisible();
  await expect(region.getByText('Дата предварительная')).toBeVisible();
  await region.getByRole('button', {name: 'Записаться в эту группу'}).click();
  await expect(page.locator('#cb-group')).toHaveValue('group-1');
  await expect(page.getByRole('heading', {name: 'Записаться в группу'})).toBeVisible();

  state.groupsFail = true;
  await page.evaluate(() => window.dispatchEvent(new Event('group-booking:refresh')));
  await expect(region.getByText('Расписание временно недоступно')).toBeVisible();
  await expect(region.locator('.groups__card')).toHaveCount(0);
  expect(await page.locator('#callback-form [data-booking-field]').evaluateAll(nodes => nodes.every(node => node.hidden))).toBe(true);
  const fallback = page.locator('#callback-form [data-booking-fallback]');
  await expect(fallback).toContainText('Расписание временно недоступно');
  await expect(fallback.getByRole('link', {name: 'Написать в WhatsApp'})).toHaveAttribute('href', /wa\.me\/995599987707\?text=/);
  await expect(fallback.getByRole('link', {name: /Позвонить/})).toHaveAttribute('href', 'tel:+995599987707');
  await expect(fallback.getByRole('button', {name: 'Обновить расписание'})).toBeVisible();
  expect(await region.evaluate(node => node.getBoundingClientRect().right <= document.documentElement.clientWidth)).toBe(true);
});

test('пустое и закрытое расписание скрывают персональные поля, а повтор восстанавливает запись', async ({page, context}) => {
  const state = await bookingFixture(context);
  state.groups = [];
  await page.goto('/');
  const form = page.locator('#callback-form');
  const fallback = form.locator('[data-booking-fallback]');
  expect(await form.locator('[data-booking-field]').evaluateAll(nodes => nodes.every(node => node.hidden))).toBe(true);
  await expect(fallback).toContainText('Ближайшая группа еще не опубликована');

  state.groups = [group({availability: 'closed', enrollmentOpen: false})];
  await fallback.getByRole('button', {name: 'Обновить расписание'}).click();
  await expect(fallback).toContainText('Сейчас нет группы с открытой записью');
  expect(await form.locator('[data-booking-field]').evaluateAll(nodes => nodes.every(node => node.hidden))).toBe(true);

  state.groups = [group({revision: 3, date: '2026-10-12'})];
  await fallback.getByRole('button', {name: 'Обновить расписание'}).click();
  await expect(fallback).toBeHidden();
  expect(await form.locator('[data-booking-field]').evaluateAll(nodes => nodes.every(node => !node.hidden))).toBe(true);
  await expect(form.locator('#cb-group option[value="group-1"]')).toContainText('12 октября 2026 г.');
  await expect(form.getByRole('button', {name: 'Отправить заявку'})).toBeEnabled();
});

for (const example of [
  {query: 'from=training&goal=theory', message: 'Здравствуйте! После тренажера ПДД хочу проконсультироваться по занятиям по теории.'},
  {query: 'from=training&goal=practice', message: 'Здравствуйте! После тренажера ПДД хочу проконсультироваться по практическому вождению.'},
  {query: 'from=exam&goal=theory', message: 'Здравствуйте! После экзамена ПДД хочу проконсультироваться по занятиям по теории.'},
  {query: 'from=exam&goal=practice', message: 'Здравствуйте! После экзамена ПДД хочу проконсультироваться по практическому вождению.'},
]) {
  test(`консультация ${example.query} не требует выбора группы`, async ({page, context}) => {
    const state = await bookingFixture(context);
    await page.goto(`/?${example.query}#contact`);
    const form = page.locator('#callback-form');
    const consultation = form.locator('[data-consultation-fallback]');
    const link = consultation.getByRole('link', {name: 'Написать в WhatsApp'});
    const href = new URL(await link.getAttribute('href'));
    expect(href.origin + href.pathname).toBe('https://wa.me/995599987707');
    expect(href.searchParams.get('text')).toBe(example.message);
    await expect(consultation).toBeVisible();
    await expect(form.locator('#cb-group')).toBeHidden();
    await expect(form.locator('#cb-name')).toBeHidden();
    await expect(form.locator('#cb-phone')).toBeHidden();
    expect(state.bookingCalls).toEqual([]);
  });
}

test('ошибка импорта booking блокирует native FormSubmit и оставляет прямые контакты', async ({page, context}) => {
  const state = await bookingFixture(context);
  await context.route(/^http:\/\/127\.0\.0\.1:8881\/js\/main\.js\?v=\d+$/, route => route.fulfill({
    contentType: 'text/javascript; charset=utf-8',
    body: mainSource.replace(/import\('\.\/booking-form\.js\?v=\d+'\)/, "import('./missing-booking-form.js')"),
  }));
  await page.goto('/');
  const form = page.locator('#callback-form');
  await expect(form.locator('[data-booking-import-fallback]')).toContainText('Онлайн-запись временно недоступна');
  await expect(form.getByRole('heading', {name: 'Связаться со школой'})).toBeVisible();
  await expect(form.locator('#cb-comment')).toBeHidden();
  await form.evaluate(node => node.requestSubmit());
  await page.waitForTimeout(100);
  expect(state.externalCalls).toEqual([]);
  await expect(form.getByRole('link', {name: 'Написать в WhatsApp'})).toBeVisible();
  await expect(form.getByRole('link', {name: /Позвонить/})).toBeVisible();
});

test('из консультации можно выбрать открытую группу и перейти к записи', async ({page, context}) => {
  const state = await bookingFixture(context);
  await page.goto('/?from=training&goal=theory#callback-form');
  const form = page.locator('#callback-form');
  await expect(form.locator('[data-consultation-fallback]')).toBeVisible();
  await page.locator('.groups__book').click();
  await expect(form.locator('[data-consultation-fallback]')).toHaveCount(0);
  await expect(form.locator('#cb-group')).toHaveValue('group-1');
  await expect(form.locator('#cb-name')).toBeVisible();
  await expect(form.getByRole('button', {name: 'Отправить заявку'})).toBeEnabled();
  expect(state.bookingCalls).toEqual([]);
});

test('отказ CAPTCHA сохраняет прямые контакты и не включает отправку после обновления групп', async ({page, context}) => {
  const state = await bookingFixture(context);
  await context.route('https://challenges.cloudflare.com/turnstile/**', route => route.abort());
  await page.goto('/');
  const form = page.locator('#callback-form');
  const fallback = form.locator('[data-booking-fallback]');
  await expect(fallback).toContainText('Не загрузилась защита от спама');
  const refreshed = page.waitForResponse('https://booking.test/api/v1/groups**');
  await page.evaluate(() => window.dispatchEvent(new Event('group-booking:refresh')));
  await refreshed;
  await expect(page.locator('.groups__book')).toBeEnabled();
  await expect(form.locator('[data-booking-submit]')).toBeDisabled();
  await expect(form.locator('#cb-name')).toBeHidden();
  await expect(fallback.getByRole('link', {name: 'Написать в WhatsApp'})).toBeVisible();
  await expect(fallback.getByRole('button', {name: 'Обновить страницу'})).toBeVisible();
  expect(state.bookingCalls).toEqual([]);
});

test('повтор после сети сохраняет key, а новая дата требует новое согласие и key', async ({page, context}) => {
  const state = await bookingFixture(context);
  state.bookingMode = 'network-then-change';
  await page.goto('/');
  await page.locator('.groups__book').click();
  const form = page.locator('#callback-form');
  await form.locator('#cb-name').fill('Анна');
  await form.locator('#cb-phone').fill('+995 599 12 34 56');
  await form.locator('[data-booking-consent]').check();
  await expect(form.getByText('Проверка пройдена')).toBeVisible();

  await form.getByRole('button', {name: 'Отправить заявку'}).click();
  await expect(form.locator('[data-booking-fail]')).toContainText('Ответ сервера не получен');
  await form.getByRole('button', {name: 'Отправить заявку'}).click();
  await expect(form.locator('[data-booking-fail]')).toContainText('Дата или статус группы изменились');
  await expect(form.locator('[data-booking-consent]')).not.toBeChecked();
  await expect(form.locator('#cb-group option:checked')).toContainText('12 октября 2026 г.');
  expect(state.bookingCalls[0].key).toBe(state.bookingCalls[1].key);

  await form.locator('[data-booking-consent]').check();
  await form.getByRole('button', {name: 'Отправить заявку'}).click();
  await expect(form.locator('[data-booking-success]')).toContainText('GR-TEST-1');
  expect(state.bookingCalls[2].key).not.toBe(state.bookingCalls[1].key);
  expect(state.bookingCalls[2].body.group_revision).toBe(3);
});

test('форма внутри чата работает при отказе AI и не передает PII модели', async ({page, context}) => {
  const state = await bookingFixture(context);
  await page.goto('/');
  await page.getByRole('button', {name: 'Открыть чат с ботом'}).click();
  await page.getByLabel('Ваш вопрос', {exact: true}).fill('Хочу записаться в группу');
  await page.getByRole('button', {name: 'Отправить сообщение'}).click();
  const booking = page.locator('.school-chat__booking-form');
  await expect(booking).toBeVisible();
  await booking.locator('[data-booking-group]').selectOption('group-1');
  await booking.locator('[data-booking-name]').fill('Иван');
  await booking.locator('[data-booking-phone]').fill('+995 599 11 22 33');
  await booking.locator('[data-booking-consent]').check();
  await booking.getByRole('button', {name: 'Отправить заявку'}).click();
  await expect(booking.locator('[data-booking-success]')).toContainText('GR-TEST-1');
  expect(state.bookingCalls.at(-1).body.source).toBe('site_chat');
  expect(state.chatCalls).toEqual([]);
});

test('чат FAQ получает расписание и отправляет структурированную заявку без секции групп', async ({page, context}) => {
  const state = await bookingFixture(context);
  await page.goto('/voprosy/');
  await expect(page.locator('[data-groups-root]')).toHaveCount(0);
  await page.getByRole('button', {name: 'Открыть чат с ботом'}).click();
  await page.getByRole('button', {name: 'Записаться в группу'}).click();
  const booking = page.locator('.school-chat__booking-form');
  const groupSelect = booking.locator('[data-booking-group]');
  await expect(groupSelect.locator('option[value="group-1"]')).toContainText('5 октября 2026 г.');
  await groupSelect.selectOption('group-1');
  await booking.locator('[data-booking-name]').fill('Мария');
  await booking.locator('[data-booking-phone]').fill('+995 599 44 55 66');
  await booking.locator('[data-booking-consent]').check();
  await booking.getByRole('button', {name: 'Отправить заявку'}).click();
  await expect(booking.locator('[data-booking-success]')).toContainText('GR-TEST-1');
  expect(state.bookingCalls.at(-1).body.source).toBe('site_chat');
  expect(state.chatCalls).toEqual([]);
});
