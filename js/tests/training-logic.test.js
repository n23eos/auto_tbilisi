import test from "node:test";
import assert from "node:assert/strict";

import {
  FILTERS,
  STORAGE_KEY,
  clampPosition,
  filterTickets,
  markAnswer,
  movePosition,
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
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("битый JSON не роняет тренажёр", () => {
  const progress = readProgress(fakeStorage("{не json"));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("хранилище с мусором вместо массивов даёт пустой прогресс", () => {
  const progress = readProgress(fakeStorage('{"solved":"всё","mistakes":7,"position":"да"}'));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("недоступное хранилище не роняет чтение", () => {
  const progress = readProgress(fakeStorage(null, { throwOnGet: true }));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("недоступное хранилище не роняет запись", () => {
  const ok = writeProgress(fakeStorage(null, { throwOnSet: true }), { solved: [], mistakes: [], position: 0 });
  assert.equal(ok, false);
});

test("запись и чтение возвращают тот же прогресс", () => {
  const storage = fakeStorage();
  writeProgress(storage, { solved: [2], mistakes: [3], position: 5 });
  assert.deepEqual(readProgress(storage), { solved: [2], mistakes: [3], position: 5 });
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
