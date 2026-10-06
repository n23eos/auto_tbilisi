import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, context }) => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:8881') return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  page.on('pageerror', error => { throw error; });
});

async function expectInFirstScreen(page, locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
}

test('новый пользователь начинает тренировку с первого экрана', async ({ page }) => {
  await page.goto('/bilety/trenirovka/');

  const start = page.locator('#t-start-today');
  await expect(start).toBeEnabled();
  await expectInFirstScreen(page, start);
  await expect(page.locator('#t-resume')).toBeHidden();
  await expect(page.locator('#t-settings')).not.toHaveAttribute('open');
  expect((await page.locator('#t-settings').boundingBox()).y)
    .toBeGreaterThan((await page.locator('#t-dashboard').boundingBox()).y);

  await start.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#t-text')).toBeFocused();
  await expect(page.locator('#t-pool-label')).toHaveText('Во всей базе');
  await expect(page.locator('#t-pool')).toHaveText('921');
  await expect(page.locator('#t-session-answered')).toHaveText('0');
  await expect(page.locator('#t-pool-progress')).toHaveAttribute('aria-valuemax', '921');
});

test('сохранённая сессия предлагает одно действие продолжения на первом экране', async ({ page }) => {
  await page.goto('/bilety/trenirovka/');
  await page.locator('#t-start-today').click();
  await page.locator('#t-answers .exam__answer').first().click();
  await expect(page.locator('#t-session-answered')).toHaveText('1');
  await page.locator('#t-next').click();
  const question = await page.locator('#t-text').textContent();

  await page.goto('/bilety/trenirovka/');
  const resume = page.locator('#t-resume-action');
  await expectInFirstScreen(page, resume);
  await expect(page.locator('#t-dashboard')).toBeHidden();
  expect((await page.locator('#t-settings').boundingBox()).y)
    .toBeGreaterThan((await page.locator('#t-resume').boundingBox()).y);

  await resume.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#t-text')).toBeFocused();
  await expect(page.locator('#t-text')).toHaveText(question);
  await expect(page.locator('#t-index')).toHaveText('2');
  await expect(page.locator('#t-session-answered')).toHaveText('1');
});

test('прогресс билета подписан отдельно от текущей сессии', async ({ page }) => {
  await page.goto('/bilety/trenirovka/?set=1');
  await expect(page.locator('#t-pool-label')).toHaveText('В билете 1');
  await expect(page.locator('#t-total')).toHaveText('30');
  await expect(page.locator('#t-pool')).toHaveText('30');
  await expect(page.locator('#t-session-answered')).toHaveText('0');
  await expect(page.locator('#t-pool-progress')).toHaveAttribute('aria-valuemax', '30');
});
