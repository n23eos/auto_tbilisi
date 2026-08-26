import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MISTAKES,
  QUESTION_COUNT,
  examVerdict,
  formatTime,
  isCorrect,
  selectExamTickets,
} from "../exam-logic.js";

function makeTickets(count, lang = "ru") {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    lang,
    question: `Вопрос ${index + 1}`,
    answers: ["А", "Б"],
    correct: 0,
    image: null,
  }));
}

test("выборка возвращает ровно 30 билетов", () => {
  const picked = selectExamTickets(makeTickets(200));
  assert.equal(picked.length, QUESTION_COUNT);
});

test("в выборке нет повторов", () => {
  const picked = selectExamTickets(makeTickets(200));
  assert.equal(new Set(picked.map((t) => t.id)).size, QUESTION_COUNT);
});

test("грузинские билеты в выборку не попадают", () => {
  const pool = [...makeTickets(40, "ru"), ...makeTickets(40, "ka")];
  const picked = selectExamTickets(pool);
  assert.ok(picked.every((t) => t.lang === "ru"));
});

test("при нехватке русских билетов выборка падает с внятной ошибкой", () => {
  const pool = [...makeTickets(5, "ru"), ...makeTickets(100, "ka")];
  assert.throws(() => selectExamTickets(pool), /русских билетов 5/);
});

test("проверка ответа сравнивает индекс с полем correct", () => {
  const ticket = { correct: 2 };
  assert.equal(isCorrect(ticket, 2), true);
  assert.equal(isCorrect(ticket, 0), false);
});

test("три ошибки — сдал", () => {
  const verdict = examVerdict({ answered: QUESTION_COUNT, mistakes: MAX_MISTAKES, timeUp: false });
  assert.equal(verdict.passed, true);
});

test("четыре ошибки — не сдал", () => {
  const verdict = examVerdict({ answered: 12, mistakes: MAX_MISTAKES + 1, timeUp: false });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "mistakes");
});

test("время вышло с неотвеченными вопросами — не сдал", () => {
  const verdict = examVerdict({ answered: 20, mistakes: 0, timeUp: true });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "time");
});

test("все 30 без ошибок — сдал", () => {
  const verdict = examVerdict({ answered: QUESTION_COUNT, mistakes: 0, timeUp: false });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "completed");
});

test("формат таймера", () => {
  assert.equal(formatTime(1800), "30:00");
  assert.equal(formatTime(65), "01:05");
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(-5), "00:00");
});
