import test from "node:test";
import assert from "node:assert/strict";

import {
  FILTERS,
  STORAGE_KEY,
  buildDailySession,
  clampPosition,
  filterTickets,
  markAnswer,
  movePosition,
  progressSummary,
  readProgress,
  writeProgress,
} from "../training-logic.js";

function fakeStorage(initial = null, { throwOnGet = false, throwOnSet = false } = {}) {
  let value = initial;
  return {
    getItem() {
      if (throwOnGet) throw new Error("хранилище недоступно");
      return value;
    },
    setItem(_key, next) {
      if (throwOnSet) throw new Error("хранилище недоступно");
      value = next;
    },
    read: () => value,
  };
}

const tickets = [
  { id: 1, lang: "ru" },
  { id: 2, lang: "ru" },
  { id: 3, lang: "ru" },
  { id: 9, lang: "ka" },
];

test("пустое хранилище даёт пустой прогресс", () => {
  const progress = readProgress(fakeStorage());
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {} });
});

test("битый JSON не роняет тренажёр", () => {
  const progress = readProgress(fakeStorage("{не json"));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {} });
});

test("хранилище с мусором вместо массивов даёт пустой прогресс", () => {
  const progress = readProgress(fakeStorage('{"solved":"всё","mistakes":7,"position":"да"}'));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {} });
});

test("недоступное хранилище не роняет чтение", () => {
  const progress = readProgress(fakeStorage(null, { throwOnGet: true }));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {} });
});

test("недоступное хранилище не роняет запись", () => {
  const ok = writeProgress(fakeStorage(null, { throwOnSet: true }), { solved: [], mistakes: [], position: 0 });
  assert.equal(ok, false);
});

test("запись и чтение возвращают тот же прогресс", () => {
  const storage = fakeStorage();
  writeProgress(storage, { solved: [2], mistakes: [3], position: 5 });
  assert.deepEqual(readProgress(storage), { solved: [2], mistakes: [3], position: 5, reviews: {} });
});

test("верный ответ добавляет билет в решённые", () => {
  const next = markAnswer({ solved: [], mistakes: [], position: 0 }, 5, true);
  assert.deepEqual(next.solved, [5]);
  assert.deepEqual(next.mistakes, []);
});

test("неверный ответ добавляет билет в ошибки и не в решённые", () => {
  const next = markAnswer({ solved: [], mistakes: [], position: 0 }, 5, false);
  assert.deepEqual(next.mistakes, [5]);
  assert.deepEqual(next.solved, []);
});

test("исправленная ошибка уходит из списка ошибок", () => {
  const after = markAnswer(markAnswer({ solved: [], mistakes: [], position: 0 }, 5, false), 5, true);
  assert.deepEqual(after.mistakes, []);
  assert.deepEqual(after.solved, [5]);
});

test("ошибка в ранее решённом билете убирает его из решённых", () => {
  const after = markAnswer({ solved: [5], mistakes: [], position: 0 }, 5, false);
  assert.deepEqual(after.solved, []);
  assert.deepEqual(after.mistakes, [5]);
});

test("markAnswer не мутирует переданный прогресс", () => {
  const before = { solved: [], mistakes: [], position: 0 };
  markAnswer(before, 5, true);
  assert.deepEqual(before, { solved: [], mistakes: [], position: 0 });
});

test("старый сохранённый прогресс получает пустую историю повторений", () => {
  const progress = readProgress(fakeStorage('{"solved":[2],"mistakes":[3],"position":1}'));
  assert.deepEqual(progress.reviews, {});
  assert.deepEqual(progress.solved, [2]);
});

test("верный ответ назначает повторение, а серия увеличивает интервал", () => {
  const day = 24 * 60 * 60 * 1000;
  const first = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, true, 1000);
  const second = markAnswer(first, 1, true, 2000);
  assert.equal(first.reviews[1].nextReviewAt, 1000 + day);
  assert.equal(second.reviews[1].nextReviewAt, 2000 + 3 * day);
  assert.equal(second.reviews[1].attempts, 2);
  assert.equal(second.reviews[1].streak, 2);
});

test("ошибка сбрасывает серию и назначает повторение сразу", () => {
  const before = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, true, 1000);
  const after = markAnswer(before, 1, false, 2000);
  assert.equal(after.reviews[1].streak, 0);
  assert.equal(after.reviews[1].nextReviewAt, 2000);
});

test("сессия на сегодня ставит ошибки и просроченные повторения перед нерешёнными", () => {
  const progress = {
    solved: [1, 2], mistakes: [2], position: 0,
    reviews: {
      1: { attempts: 1, streak: 1, lastAnsweredAt: 10, nextReviewAt: 50 },
      2: { attempts: 1, streak: 0, lastAnsweredAt: 20, nextReviewAt: 20 },
    },
  };
  const list = buildDailySession(tickets, progress, 100, 3);
  assert.deepEqual(list.map((ticket) => ticket.id), [1, 2, 3]);
});

test("сессия на сегодня ограничена двадцатью билетами", () => {
  const pool = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, lang: "ru" }));
  const list = filterTickets(pool, { solved: [], mistakes: [], position: 0, reviews: {} }, FILTERS.TODAY, 100);
  assert.equal(list.length, 20);
});

test("сводка считает только действующие русские билеты", () => {
  const pool = [...tickets, { id: 4, lang: "ru", withdrawn: true }];
  const summary = progressSummary(pool, {
    solved: [1, 4, 9], mistakes: [2, 4], position: 0,
    reviews: { 1: { nextReviewAt: 50 }, 2: { nextReviewAt: 200 } },
  }, 100);
  assert.deepEqual(summary, { total: 3, solved: 1, due: 2, remaining: 2, mistakes: 1 });
});

test("фильтр «все» отдаёт только русские билеты", () => {
  const list = filterTickets(tickets, { solved: [], mistakes: [], position: 0 }, FILTERS.ALL);
  assert.deepEqual(list.map((t) => t.id), [1, 2, 3]);
});

test("фильтр «нерешённые» исключает решённые", () => {
  const list = filterTickets(tickets, { solved: [2], mistakes: [], position: 0 }, FILTERS.UNSOLVED);
  assert.deepEqual(list.map((t) => t.id), [1, 3]);
});

test("фильтр «мои ошибки» отдаёт только ошибочные", () => {
  const list = filterTickets(tickets, { solved: [], mistakes: [3], position: 0 }, FILTERS.MISTAKES);
  assert.deepEqual(list.map((t) => t.id), [3]);
});

test("грузинские билеты не попадают ни в один фильтр", () => {
  for (const filter of Object.values(FILTERS)) {
    const list = filterTickets(tickets, { solved: [9], mistakes: [9], position: 0 }, filter);
    assert.ok(list.every((t) => t.lang === "ru"));
  }
});

test("изъятые билеты не попадают ни в один фильтр", () => {
  const pool = [
    { id: 1, lang: "ru" },
    { id: 2, lang: "ru", withdrawn: true },
  ];
  for (const filter of Object.values(FILTERS)) {
    const list = filterTickets(pool, { solved: [2], mistakes: [2], position: 0 }, filter);
    assert.ok(list.every((t) => !t.withdrawn));
  }
});

test("позиция не уходит за границы списка", () => {
  assert.equal(clampPosition(99, 3), 2);
  assert.equal(clampPosition(-4, 3), 0);
  assert.equal(clampPosition(1, 0), 0);
  assert.equal(clampPosition("нет", 3), 0);
});

test("переход вперёд с последнего билета остаётся на последнем", () => {
  assert.equal(movePosition(2, 1, 3), 2);
});

test("переход назад с первого билета остаётся на первом", () => {
  assert.equal(movePosition(0, -1, 3), 0);
});
