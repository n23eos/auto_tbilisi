import test from "node:test";
import assert from "node:assert/strict";
import { FILTERS, selectTrainingTickets, toggleFavorite, readProgress, markAnswer } from "../training-logic.js";

const progress = { solved: [], mistakes: [], favorites: [], reviews: {}, position: 0 };
const tickets = [
  { id: 1, lang: "ru", question: "Зелёный автомобиль на перекрёстке" },
  { id: 10, lang: "ru", question: "Скорость движения" },
  { id: 11, lang: "ru", question: "Зеленый автомобиль", withdrawn: true },
  { id: 12, lang: "ka", question: "Зеленый автомобиль" },
];
const ids = (options, p = progress) => selectTrainingTickets(tickets, p, options).map(t => t.id);

test("поиск номера точный, поддерживает # и не показывает скрытые вопросы", () => {
  assert.deepEqual(ids({ query: "1" }), [1]);
  assert.deepEqual(ids({ query: " #10 " }), [10]);
  assert.deepEqual(ids({ query: "11" }), []);
  assert.deepEqual(ids({ query: "12" }), []);
});

test("поиск слов нечувствителен к регистру и ё, требует все слова", () => {
  assert.deepEqual(ids({ query: "  ЗЕЛЕНЫЙ перекрестке " }), [1]);
  assert.deepEqual(ids({ query: "автомобиль скорость" }), []);
});

test("тема, поиск и режим пересекаются", () => {
  const topics = [{ id: 2, ticket_ids: [10] }];
  assert.deepEqual(ids({ topicId: "2", topics }), [10]);
  assert.deepEqual(ids({ topicId: "404", topics }), []);
  assert.deepEqual(ids({ topicId: "2", topics, query: "1" }), []);
  assert.deepEqual(ids({ topicId: "2", topics, filter: FILTERS.MISTAKES }, { ...progress, mistakes: [10] }), [10]);
});

test("поиск и тема применяются до ограничения короткой сессии", () => {
  const pool = Array.from({length: 40}, (_, i) => ({id: i + 1, lang: "ru", question: "Вопрос"}));
  const topics = [{ id: 1, ticket_ids: pool.slice(20).map(t => t.id) }];
  const result = selectTrainingTickets(pool, progress, {filter: FILTERS.TODAY, topicId: 1, topics, limit: 10});
  assert.deepEqual(result.map(t => t.id), [21,22,23,24,25,26,27,28,29,30]);
  assert.deepEqual(selectTrainingTickets(pool, progress, {filter: FILTERS.TODAY, query:"40",limit:10}).map(t => t.id), [40]);
});

test("избранное переживает ответы, запись и старый формат прогресса", () => {
  const old = readProgress({getItem: () => JSON.stringify({solved:[1], mistakes:[], position:2})});
  assert.deepEqual(old.favorites, []);
  const saved = toggleFavorite(old, 10);
  assert.deepEqual(old.favorites, []);
  const answered = markAnswer(saved, 10, true);
  const restored = readProgress({getItem: () => JSON.stringify(answered)});
  assert.deepEqual(restored.favorites, [10]);
  assert.deepEqual(ids({filter:FILTERS.FAVORITES},restored), [10]);
  assert.deepEqual(toggleFavorite(restored, 10).favorites, []);
});

test("испорченное избранное не ломает прогресс", () => {
  const restored = readProgress({getItem: () => '{"solved":[1],"favorites":[10,10,"x",null]}'});
  assert.deepEqual(restored.favorites, [10]);
  assert.deepEqual(restored.solved, [1]);
});
