import test from "node:test";
import assert from "node:assert/strict";

import {
  FILTERS,
  STORAGE_KEY,
  answerOutcome,
  buildDailySession,
  clampPosition,
  createSession,
  filterTickets,
  markAnswer,
  movePosition,
  progressSummary,
  readProgress,
  recordSessionAnswer,
  sessionSummary,
  writeProgress,
  selectTrainingTickets,
  toggleFavorite,
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
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] });
});

test("битый JSON не роняет тренажёр", () => {
  const progress = readProgress(fakeStorage("{не json"));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] });
});

test("хранилище с мусором вместо массивов даёт пустой прогресс", () => {
  const progress = readProgress(fakeStorage('{"solved":"всё","mistakes":7,"position":"да"}'));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] });
});

test("недоступное хранилище не роняет чтение", () => {
  const progress = readProgress(fakeStorage(null, { throwOnGet: true }));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] });
});

test("недоступное хранилище не роняет запись", () => {
  const ok = writeProgress(fakeStorage(null, { throwOnSet: true }), { solved: [], mistakes: [], position: 0 });
  assert.equal(ok, false);
});

test("запись и чтение возвращают тот же прогресс", () => {
  const storage = fakeStorage();
  writeProgress(storage, { solved: [2], mistakes: [3], position: 5 });
  assert.deepEqual(readProgress(storage), { solved: [2], mistakes: [3], position: 5, reviews: {}, favorites: [] });
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

test("старое повторение получает пустую историю закрепления ошибки", () => {
  const progress = readProgress(fakeStorage(JSON.stringify({
    reviews: { 1: { attempts: 2, streak: 1, lastAnsweredAt: 10, nextReviewAt: 20 } },
  })));
  assert.deepEqual(progress.reviews[1], {
    attempts: 2,
    streak: 1,
    lastAnsweredAt: 10,
    nextReviewAt: 20,
    lastWrongAt: 0,
    reinforcedAt: 0,
  });
});

test("некорректные поля повторения безопасно сбрасываются", () => {
  const progress = readProgress(fakeStorage(JSON.stringify({
    reviews: {
      1: {
        attempts: -1,
        streak: "2",
        lastAnsweredAt: -10,
        nextReviewAt: "20",
        lastWrongAt: null,
        reinforcedAt: Infinity,
      },
      bad: { attempts: 3 },
      2: null,
    },
  })));
  assert.deepEqual(progress.reviews, {
    1: {
      attempts: 0,
      streak: 0,
      lastAnsweredAt: 0,
      nextReviewAt: 0,
      lastWrongAt: 0,
      reinforcedAt: 0,
    },
  });
});

test("поля закрепления сохраняются после чтения, ответа и записи", () => {
  const storage = fakeStorage(JSON.stringify({
    solved: [],
    mistakes: [1],
    reviews: {
      1: {
        attempts: 1,
        streak: 0,
        lastAnsweredAt: 100,
        nextReviewAt: 100,
        lastWrongAt: 100,
        reinforcedAt: 0,
      },
    },
  }));
  const progress = markAnswer(readProgress(storage), 2, true, 200);
  writeProgress(storage, progress);
  const restored = readProgress(storage);
  assert.equal(restored.reviews[1].lastWrongAt, 100);
  assert.equal(restored.reviews[1].reinforcedAt, 0);
});

test("досрочный правильный ответ не увеличивает серию и не переносит срок", () => {
  const day = 24 * 60 * 60 * 1000;
  const first = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, true, 1000);
  const second = markAnswer(first, 1, true, 2000);
  assert.equal(first.reviews[1].nextReviewAt, 1000 + day);
  assert.equal(second.reviews[1].nextReviewAt, first.reviews[1].nextReviewAt);
  assert.equal(second.reviews[1].attempts, 2);
  assert.equal(second.reviews[1].streak, 1);

  const due = markAnswer(second, 1, true, first.reviews[1].nextReviewAt);
  assert.equal(due.reviews[1].streak, 2);
  assert.equal(due.reviews[1].nextReviewAt, first.reviews[1].nextReviewAt + 3 * day);
});

test("ошибка сбрасывает серию и назначает повторение сразу", () => {
  const before = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, true, 1000);
  const after = markAnswer(before, 1, false, 2000);
  assert.equal(after.reviews[1].streak, 0);
  assert.equal(after.reviews[1].nextReviewAt, 2000);
});

test("закрепление после быстрого исправления требует ещё сутки без показа билета", () => {
  const day = 24 * 60 * 60 * 1000;
  const wrongAt = 1000;
  const wrong = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, false, wrongAt);
  assert.deepEqual(answerOutcome(wrong, 1, true, wrongAt + day - 1), {
    corrected: true,
    reinforced: false,
  });

  const immediateOutcome = answerOutcome(wrong, 1, true, wrongAt + 100);
  const corrected = markAnswer(wrong, 1, true, wrongAt + 100);
  assert.deepEqual(immediateOutcome, { corrected: true, reinforced: false });
  assert.deepEqual(answerOutcome(corrected, 1, true, wrongAt + day), {
    corrected: false,
    reinforced: false,
  });
  assert.deepEqual(answerOutcome(corrected, 1, true, wrongAt + day + 99), {
    corrected: false,
    reinforced: false,
  });
  assert.deepEqual(answerOutcome(corrected, 1, true, wrongAt + day + 100), {
    corrected: false,
    reinforced: true,
  });
});

test("ответ перед границей суток не позволяет получить награду немедленным повтором", () => {
  const day = 24 * 60 * 60 * 1000;
  const minute = 60 * 1000;
  const wrongAt = 1000;
  const wrong = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, false, wrongAt);
  const almostDayLater = markAnswer(wrong, 1, true, wrongAt + day - minute);

  assert.equal(answerOutcome(almostDayLater, 1, true, wrongAt + day).reinforced, false);
  assert.equal(answerOutcome(almostDayLater, 1, true, wrongAt + 2 * day - minute).reinforced, true);
});

test("закрепление выдаётся один раз до следующей ошибки", () => {
  const day = 24 * 60 * 60 * 1000;
  const wrong = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, false, 1000);
  const reinforced = markAnswer(wrong, 1, true, 1000 + day);
  assert.equal(reinforced.reviews[1].reinforcedAt, 1000 + day);
  assert.equal(answerOutcome(reinforced, 1, true, 1000 + 2 * day).reinforced, false);

  const wrongAgain = markAnswer(reinforced, 1, false, 1000 + 3 * day);
  assert.equal(answerOutcome(wrongAgain, 1, true, 1000 + 4 * day).reinforced, true);
});

test("срок закрепления считается от самой свежей ошибки", () => {
  const day = 24 * 60 * 60 * 1000;
  const first = markAnswer({ solved: [], mistakes: [], position: 0, reviews: {} }, 1, false, 1000);
  const latest = markAnswer(first, 1, false, 1000 + day - 100);
  assert.equal(answerOutcome(latest, 1, true, 1000 + day).reinforced, false);
  assert.equal(answerOutcome(latest, 1, true, 1000 + 2 * day - 100).reinforced, true);
});

test("сессия фиксирует исходные билеты и ошибки", () => {
  const sourceTickets = [{ id: 1 }, { id: 2 }];
  const sourceProgress = { mistakes: [2] };
  const session = createSession(sourceTickets, sourceProgress);
  sourceTickets.push({ id: 3 });
  sourceProgress.mistakes.push(1);

  assert.deepEqual(session.ticketIds, [1, 2]);
  assert.deepEqual(session.originalMistakeIds, [2]);
  assert.throws(() => session.ticketIds.push(3), TypeError);

  const answered = recordSessionAnswer(session, 2, true, { corrected: true, reinforced: true });
  assert.deepEqual(session.answers, {});
  assert.deepEqual(answered.answers[2], { correct: true, corrected: true, reinforced: true });
});

test("сессия игнорирует неизвестные и повторные ответы", () => {
  const initial = createSession([{ id: 1 }, { id: 2 }, { id: 3 }], { mistakes: [] });
  const unknown = recordSessionAnswer(initial, 99, true, { reinforced: true });
  assert.equal(unknown, initial);

  const first = recordSessionAnswer(initial, 1, false);
  const duplicate = recordSessionAnswer(first, 1, true, { reinforced: true });
  assert.equal(duplicate, first);
  assert.deepEqual(sessionSummary(duplicate), {
    total: 3,
    answered: 1,
    correct: 0,
    incorrect: 1,
    skipped: 2,
    corrected: 0,
    reinforced: 0,
    complete: false,
  });
});

test("сводка сессии считает только первые ответы, исправления и закрепления", () => {
  let session = createSession([{ id: 1 }, { id: 2 }], { mistakes: [1] });
  session = recordSessionAnswer(session, 1, true, { corrected: true, reinforced: false });
  session = recordSessionAnswer(session, 2, true, { corrected: false, reinforced: true });
  assert.deepEqual(sessionSummary(session), {
    total: 2,
    answered: 2,
    correct: 2,
    incorrect: 0,
    skipped: 0,
    corrected: 1,
    reinforced: 1,
    complete: true,
  });
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

test("сводка считает все русские билеты, включая спорные", () => {
  const pool = [...tickets, { id: 4, lang: "ru", withdrawn: true }];
  const summary = progressSummary(pool, {
    solved: [1, 4, 9], mistakes: [2, 4], position: 0,
    reviews: { 1: { nextReviewAt: 50 }, 2: { nextReviewAt: 200 } },
  }, 100);
  assert.deepEqual(summary, { total: 4, solved: 2, due: 3, remaining: 2, mistakes: 2 });
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

test("билеты с пометкой withdrawn остаются доступны в тренировке", () => {
  const pool = [
    { id: 1, lang: "ru" },
    { id: 2, lang: "ru", withdrawn: true },
  ];
  const progress = { solved: [], mistakes: [2], favorites: [2], reviews: {}, position: 0 };
  for (const filter of [FILTERS.ALL, FILTERS.UNSOLVED, FILTERS.MISTAKES, FILTERS.FAVORITES, FILTERS.TODAY]) {
    assert.ok(filterTickets(pool, progress, filter).some((ticket) => ticket.id === 2), filter);
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
