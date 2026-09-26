import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { applyRussianTranslations } from '../../js/ticket-bank.js';

const read = name => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url)));
const translations = Object.assign({}, ...['1742-1758', '1759-1775', '1776-1792'].map(range => read(`eco-ru-${range}.json`)));
const tickets = applyRussianTranslations(read('tickets-b-ru.json').tickets, translations);

const test = base.extend({
  externalPosts: async ({ context }, use) => {
    const posts = [];
    // Даже ошибочный submit в регрессии не должен отправить настоящую заявку.
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:8881') return route.continue();
      if (request.method() === 'POST') posts.push(request.url());
      if (url.pathname === '/api/catalog') return route.fulfill({ json: { services: [] } });
      return route.fulfill({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'text/plain', body: '' });
    });
    await use(posts);
  },
});

test.beforeEach(async ({ page, externalPosts }) => {
  void externalPosts;
  page.on('pageerror', error => { throw error; });
});

async function noHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // overflow-x: hidden может скрыть обрезанную ссылку, не увеличив scrollWidth.
  expect(await page.locator('.nav__link').evaluateAll(nodes => nodes.every(node => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= document.documentElement.clientWidth;
  }))).toBe(true);
}

test('главная: действия перед купонами, форма показывает ошибки без отправки', async ({ page, externalPosts }) => {
  await page.goto('/');
  const signup = page.getByRole('link', { name: 'Записаться на обучение', exact: true });
  const coupon = page.getByRole('region', { name: 'Для ваших путешествий' });
  await expect(signup).toBeInViewport();
  expect(await signup.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.partners')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  if (page.viewportSize().width < 896) expect((await signup.boundingBox()).y).toBeLessThan((await coupon.boundingBox()).y);
  await expect(page.getByText('HOLAAVTO', { exact: true })).toBeVisible();
  await expect(page.getByText('NEW10', { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await signup.click();
  await page.getByRole('button', { name: 'Перезвоните мне' }).click();
  await expect(page.locator('#cb-name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#cb-phone')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#cb-name')).toBeFocused();
  expect(externalPosts).toEqual([]);
});

test('чат не открывается сам, загружает аватар по запросу и возвращает фокус', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Открыть чат с ботом' });
  await expect(toggle).toBeVisible();
  const panel = page.locator('#school-chat-panel');
  const avatar = page.locator('.school-chat__avatar');
  await expect(avatar).not.toHaveAttribute('src');
  // Прежний дефект проявлялся ровно через 10 секунд после загрузки.
  await page.waitForTimeout(10500);
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(avatar).toHaveAttribute('src', /chat-robot-132\.webp$/);
  await expect(page.getByLabel('Ваш вопрос', { exact: true })).toBeFocused();
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('каталог содержит 921 вопрос, точный поиск открывает нужный ID', async ({ page }) => {
  await page.goto('/bilety/voprosy/');
  await expect(page.locator('.question-tile')).toHaveCount(921);
  await page.getByLabel('Текст вопроса или ID источника').fill('#337');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.locator('.question-tile')).toHaveCount(1);
  await expect(page.locator('.question-tile')).toHaveAttribute('href', '/bilety/trenirovka/?ticket=337');
  await page.locator('.question-tile').click();
  await expect(page.locator('#t-source-id')).toHaveText('337');
  await expect(page.locator('#t-text')).not.toBeEmpty();
  await noHorizontalOverflow(page);
});

test('тренировка: ответ, следующий вопрос и продолжение после перезагрузки', async ({ page }) => {
  await page.goto('/bilety/trenirovka/');
  await page.locator('#t-start-today').click();
  await page.locator('#t-answers .exam__answer').first().click();
  await expect(page.locator('#t-answers .exam__answer').first()).toBeDisabled();
  await expect(page.locator('#t-answers .exam__answer--correct .sr-only')).toHaveText(' (Правильный ответ)');
  await page.locator('#t-next').click();
  await expect(page.locator('#t-index')).toHaveText('2');
  await expect(page.locator('#t-text')).toBeFocused();
  const question = await page.locator('#t-text').textContent();
  await expect(page.locator('#t-settings')).not.toHaveAttribute('open');
  await page.reload();
  await expect(page.locator('#t-index')).toHaveText('2');
  await expect(page.locator('#t-session-status')).toContainText('Занятие восстановлено');
  await page.goto('/bilety/trenirovka/');
  await expect(page.locator('#t-resume')).toBeVisible();
  await page.locator('#t-resume-action').click();
  await expect(page.locator('#t-text')).toBeFocused();
  await expect(page.locator('#t-text')).toHaveText(question);
  await expect(page.locator('#t-index')).toHaveText('2');
  await page.locator('#t-prev').click();
  await expect(page.locator('#t-answers .exam__answer').first()).toBeDisabled();
  await expect(page.locator('#t-answers .exam__answer--correct')).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test('экзамен: пропуск, неверный ответ и остановка после шестой ошибки', async ({ page }) => {
  await page.goto('/bilety/ekzamen/');
  await page.getByRole('button', { name: 'Начать экзамен', exact: true }).click();
  await expect(page.locator('#q-total')).toHaveText('30');
  await page.getByRole('button', { name: 'Пропустить', exact: true }).click();
  await expect(page.locator('#q-index')).toHaveText('2');
  for (let mistake = 1; mistake <= 6; mistake++) {
    const question = await page.locator('#q-text').textContent();
    const answers = await page.locator('#q-answers .exam__answer > span:last-child').allTextContents();
    const image = await page.locator('#q-image').getAttribute('src');
    // В банке повторяются тексты вопросов с разными рисунками и ответами.
    const matches = tickets.filter(item => item.question === question
      && JSON.stringify(item.answers) === JSON.stringify(answers)
      && (item.image ? image?.endsWith(item.image) : !image));
    expect(new Set(matches.map(item => item.correct)).size).toBe(1);
    const ticket = matches[0];
    await page.locator('#q-answers .exam__answer').nth(ticket.correct === 0 ? 1 : 0).click();
    await expect(page.locator('#q-mistakes')).toHaveText(String(mistake));
    await expect(page.locator('#q-answers .exam__answer--wrong .sr-only')).toHaveText(' (Ваш ответ, неверный)');
    if (mistake < 6) await page.locator('#btn-next').click();
  }
  await expect(page.locator('#screen-result')).toBeVisible();
  await expect(page.locator('#r-review > li')).toHaveCount(6);
  await noHorizontalOverflow(page);
});

test('свёрнутые панели оставляют доступными навигацию, избранное и поиск', async ({ page }) => {
  await page.goto('/bilety/trenirovka/?set=1');
  await expect(page.locator('#t-source-id')).toHaveText('1');
  await expect(page.locator('#t-settings')).not.toHaveAttribute('open');
  await page.locator('#t-question-nav > summary').press('Enter');
  await page.locator('#t-question-nav-grid').getByRole('button', { name: 'Вопрос 3', exact: true }).click();
  await expect(page.locator('#t-index')).toHaveText('3');
  const favoriteId = await page.locator('#t-source-id').textContent();
  await expect(page.locator('#t-question-nav')).not.toHaveAttribute('open');
  await expect(page.locator('#t-text')).toBeFocused();
  await page.keyboard.press('1');
  await expect(page.locator('#t-answers .exam__answer').first()).toBeDisabled();
  await page.locator('#t-favorite').click();
  await expect(page.locator('#t-favorite')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#t-settings > summary').click();
  await page.locator('#t-exit-set').click();
  await page.locator('#t-settings > summary').click();
  await page.locator('#filter-favorites').click();
  await expect(page.locator('#t-total')).toHaveText('1');
  await expect(page.locator('#t-source-id')).toHaveText(favoriteId);
  await page.locator('#t-settings > summary').click();
  await page.locator('#filter-all').click();
  await expect(page.locator('#t-total')).toHaveText('921');
  await page.locator('#t-settings > summary').click();
  await page.getByLabel('Номер или слова из вопроса').fill('337');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.locator('#t-source-id')).toHaveText('337');
  await expect(page.locator('#t-settings')).not.toHaveAttribute('open');
  await noHorizontalOverflow(page);
});
