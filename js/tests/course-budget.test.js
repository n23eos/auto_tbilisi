import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateBudget, parsePriceText} from '../course-budget-logic.js';

const prices = {
  theory_group: 15000, theory_individual_online: 28000,
  driving_ground: 4000, driving_city: 5000,
  medical_certificate: 4500, state_theory_first: 5500, state_city_exam: 9000,
};
const selection = {theoryService: 'theory_group', groundLessons: 5, cityLessons: 3, includeExamCosts: true};

test('бюджет отделяет выбранные занятия от справки и первых экзаменов', () => {
  const result = calculateBudget(selection, prices);
  assert.equal(result.schoolMinor, 50000);
  assert.equal(result.extrasMinor, 19000);
  assert.equal(result.totalMinor, 69000);
  assert.equal(result.lines.find(line => line.serviceId === 'driving_city').quantity, 3);
});

test('новые опубликованные цены используются без второго списка тарифов', () => {
  const result = calculateBudget(selection, {...prices, theory_group: 17000, driving_ground: 4500});
  assert.equal(result.totalMinor, 73500);
});

test('только практика и нулевое число уроков не требуют цену теории или невыбранных расходов', () => {
  const result = calculateBudget({theoryService: 'none', groundLessons: 0, cityLessons: 2, includeExamCosts: false}, {driving_city: 5000});
  assert.equal(result.totalMinor, 10000);
  assert.deepEqual(result.missingServices, []);
});

test('неизвестная выбранная цена не превращается в бесплатное обучение', () => {
  const result = calculateBudget(selection, {...prices, driving_city: null});
  assert.equal(result.totalMinor, null);
  assert.equal(result.schoolMinor, null);
  assert.equal(result.extrasMinor, 19000);
  assert.deepEqual(result.missingServices, ['driving_city']);
});

test('отрицательная, дробная или слишком большая цена не попадает в итог', () => {
  for (const price of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.equal(calculateBudget(selection, {...prices, driving_city: price}).totalMinor, null);
  }
});

test('количество уроков ограничено целыми числами от нуля до ста', () => {
  for (const quantity of [-1, 0.5, 101, NaN, '', '5']) {
    assert.equal(calculateBudget({...selection, groundLessons: quantity}, prices).valid, false);
  }
  assert.equal(calculateBudget({...selection, groundLessons: 100}, prices).valid, true);
  assert.equal(calculateBudget({...selection, theoryService: 'untrusted'}, prices).valid, false);
});

test('опубликованные суммы переводятся в minor units с русским форматированием', () => {
  assert.equal(parsePriceText('150 ₾'), 15000);
  assert.equal(parsePriceText('1\u00a0250,50 ₾'), 125050);
  assert.equal(parsePriceText('40.25 ₾'), 4025);
  for (const value of ['Уточните цену', 'от 150 ₾', '-40 ₾', '150 USD', '1,005 ₾']) {
    assert.equal(parsePriceText(value), null);
  }
});
