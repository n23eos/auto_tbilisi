import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MISTAKES,
  QUESTION_COUNT,
  createExamAnswers,
  examProgress,
  examVerdict,
  formatTime,
  isExamTerminal,
  isCorrect,
  nextUnansweredIndex,
  recordExamAnswer,
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

test("билеты с пометкой withdrawn доступны в экзамене", () => {
  const pool = makeTickets(30, "ru").map((ticket) => ({ ...ticket, withdrawn: true }));
  const picked = selectExamTickets(pool);
  assert.equal(picked.length, 30);
  assert.ok(picked.every((ticket) => ticket.withdrawn));
});

test("проверка ответа сравнивает индекс с полем correct", () => {
  const ticket = { correct: 2 };
  assert.equal(isCorrect(ticket, 2), true);
  assert.equal(isCorrect(ticket, 0), false);
});

test("пропущенный вопрос остаётся без ответа и возвращается после остальных", () => {
  let answers = createExamAnswers(3);
  answers = recordExamAnswer(answers, 1, 0, 0).answers;
  answers = recordExamAnswer(answers, 2, 1, 1).answers;

  assert.equal(nextUnansweredIndex(answers, 0), 0);
  assert.deepEqual(examProgress(answers), { answered: 2, mistakes: 0 });
});

test("переход ищет следующий вопрос без ответа по кругу", () => {
  let answers = createExamAnswers(4);
  answers = recordExamAnswer(answers, 0, 0, 0).answers;
  answers = recordExamAnswer(answers, 2, 0, 0).answers;
  answers = recordExamAnswer(answers, 3, 0, 0).answers;

  assert.equal(nextUnansweredIndex(answers, 2), 1);
});

test("повторный ответ на вопрос не меняет результат", () => {
  const empty = createExamAnswers(2);
  const first = recordExamAnswer(empty, 0, 1, 0);
  const duplicate = recordExamAnswer(first.answers, 0, 0, 0);

  assert.equal(first.recorded, true);
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.answers, first.answers);
  assert.deepEqual(examProgress(duplicate.answers), { answered: 1, mistakes: 1 });
});

test("после ответов на все вопросы незавершённых не остаётся", () => {
  let answers = createExamAnswers(QUESTION_COUNT);
  answers = answers.map(() => ({ chosen: 0, correct: true }));

  assert.equal(nextUnansweredIndex(answers, QUESTION_COUNT - 1), -1);
  const progress = examProgress(answers);
  assert.equal(progress.answered, QUESTION_COUNT);
  assert.equal(examVerdict({ ...progress, timeUp: false }).passed, true);
});

test("экзамен блокирует новые ответы сразу после условия завершения", () => {
  assert.equal(isExamTerminal({ answered: QUESTION_COUNT, mistakes: 0 }), true);
  assert.equal(isExamTerminal({ answered: 12, mistakes: MAX_MISTAKES + 1 }), true);
  assert.equal(isExamTerminal({ answered: 12, mistakes: MAX_MISTAKES }), false);
});

test("ошибок ровно по порогу — сдал", () => {
  const verdict = examVerdict({ answered: QUESTION_COUNT, mistakes: MAX_MISTAKES, timeUp: false });
  assert.equal(verdict.passed, true);
});

test("на одну ошибку больше порога — не сдал", () => {
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
