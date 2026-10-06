import {test as base, expect} from '@playwright/test';

const test = base.extend({
  externalPosts: async ({context}, use) => {
    const posts = [];
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:8881') return route.continue();
      if (request.method() === 'POST') posts.push(request.url());
      if (url.pathname === '/api/catalog') return route.fulfill({json: {services: []}});
      if (url.pathname === '/api/v1/groups') return route.fulfill({status: 503, json: {error: 'booking_unconfigured'}});
      return route.fulfill({status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'text/plain', body: ''});
    });
    await use(posts);
  },
});

test.beforeEach(async ({page, externalPosts}) => {
  void externalPosts;
  page.on('pageerror', error => {throw error;});
});

test('выбор обучения ведет к группе или прямой консультации без обязательной группы', async ({page, externalPosts}) => {
  await page.goto('/#prices');
  const choices = page.getByLabel('Выберите обучение', {exact: true});
  await expect(choices.getByRole('heading')).toHaveText(['С нуля', 'Только теория', 'Практика вождения']);
  const practice = choices.getByRole('link', {name: 'Подобрать вождение', exact: true});
  const href = new URL(await practice.getAttribute('href'));
  expect(href.hostname).toBe('wa.me');
  expect(href.searchParams.get('text')).toContain('практическому вождению');
  await choices.getByRole('link', {name: 'Выбрать дату группы'}).click();
  await expect(page).toHaveURL(/#groups$/);
  await expect(page.getByRole('link', {name: 'Уточнить дату в WhatsApp'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(externalPosts).toEqual([]);
});

test('расчет отделяет занятия и расходы на справку и первые экзамены', async ({page, externalPosts}) => {
  await page.goto('/#budget');
  await page.getByText('Рассчитать бюджет обучения', {exact: true}).click();
  const budget = page.getByRole('form', {name: 'Расчет бюджета обучения'});
  await budget.getByLabel('Занятия на площадке').fill('5');
  await budget.getByLabel('Занятия в городе').fill('3');
  await expect(budget.locator('[data-budget-school]')).toHaveText('500 ₾');
  await expect(budget.locator('[data-budget-extras]')).toHaveText('0 ₾');
  await budget.getByLabel('Добавить медицинскую справку', {exact: false}).check();
  await expect(budget.locator('[data-budget-extras]')).toHaveText('190 ₾');
  await expect(budget.locator('[data-budget-total]')).toHaveText('690 ₾');
  await budget.getByRole('combobox', {name: 'Теория', exact: true}).selectOption('none');
  await expect(budget.locator('[data-budget-total]')).toHaveText('540 ₾');
  await budget.getByLabel('Занятия в городе').fill('1.5');
  await expect(budget.getByLabel('Занятия в городе')).toHaveAttribute('aria-invalid', 'true');
  await expect(budget.locator('[data-budget-total]')).toHaveText('Проверьте количество занятий');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(externalPosts).toEqual([]);
});

test('обновленный прайс меняет карточки и итог, неизвестная цена не считается нулем', async ({page}) => {
  let services = [{service_id: 'theory_group', status: 'success', amount_minor: 17000}];
  await page.route('**/api/catalog', route => route.fulfill({json: {services}}));
  await page.goto('/#budget');
  await page.getByText('Рассчитать бюджет обучения', {exact: true}).click();
  await expect(page.locator('[data-budget-total]')).toHaveText('170 ₾');
  await expect(page.locator('.course-choice [data-price-service="theory_group"]')).toHaveText(['170 ₾', '170 ₾']);
  services = [{service_id: 'theory_group', status: 'unknown'}];
  await page.reload();
  await page.getByText('Рассчитать бюджет обучения', {exact: true}).click();
  await expect(page.locator('[data-budget-total]')).toHaveText('Уточните цену');
  await expect(page.locator('[data-budget-message]')).toContainText('уточните недоступные цены');
  await page.getByRole('combobox', {name: 'Теория', exact: true}).selectOption('none');
  await page.getByLabel('Занятия в городе').fill('2');
  await expect(page.locator('[data-budget-total]')).toHaveText('100 ₾');
});

test.describe('без JavaScript', () => {
  test.use({javaScriptEnabled: false});
  test('предложения, прайс и прямые контакты доступны', async ({page}) => {
    await page.goto('/#prices');
    await expect(page.locator('.course-choice__card')).toHaveCount(3);
    await expect(page.getByRole('link', {name: 'Подобрать вождение', exact: true})).toBeVisible();
    await expect(page.locator('#prices-table [data-price-service="theory_group"]')).toHaveText('150 ₾');
    await page.getByText('Рассчитать бюджет обучения', {exact: true}).click();
    await expect(page.getByText('Для расчета включите JavaScript', {exact: false})).toBeVisible();
  });
});
