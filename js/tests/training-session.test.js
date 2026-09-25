import test from "node:test";
import assert from "node:assert/strict";
import { createSession, recordSessionAnswer, sessionSummary } from "../training-logic.js";
import {
  SESSION_STORAGE_KEY,
  discardSession,
  makeSessionSnapshot,
  readSession,
  readSessionSummary,
  shouldRestoreSession,
  validateSessionSnapshot,
  writeSession,
} from "../training-session.js";

const bank = [
  { id: 1, lang: "ru", question: "Первый?", answers: ["Да", "Нет"], correct: 0 },
  { id: 2, lang: "ru", question: "Второй?", answers: ["Да", "Нет"], correct: 1 },
  { id: 3, lang: "ru", question: "Третий?", answers: ["Да", "Нет"], correct: 0 },
];
const sets = [{ number: 1, tickets: bank }];
const topics = [{ id: 19, name: "Тема", ticket_ids: [1, 2, 3] }];

function memory() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function saved() {
  const list = [bank[2], bank[0], bank[1]];
  const progress = { mistakes: [1] };
  let session = createSession(list, progress);
  session = recordSessionAnswer(session, 3, true, {});
  session = recordSessionAnswer(session, 1, true, { corrected: true, reinforced: true });
  return makeSessionSnapshot({
    list,
    position: 2,
    selectedAnswers: {
      3: { index: 0, outcome: { corrected: false, reinforced: false } },
      1: { index: 0, outcome: { corrected: true, reinforced: true } },
    },
    session,
    sessionStarted: true,
    filter: "today",
    query: "",
    topicId: "19",
    limit: 10,
    set: null,
  });
}

test("сохраняет порядок, позицию, первые ответы и счётчики без повторного учёта", () => {
  const storage = memory();
  const snapshot = saved();
  assert.equal(writeSession(storage, snapshot), true);
  const first = readSession(storage, bank, sets, topics);
  const second = readSession(storage, bank, sets, topics);
  assert.equal(first.status, "ok");
  assert.deepEqual(first.value.tickets.map((ticket) => ticket.id), [3, 1, 2]);
  assert.equal(first.value.snapshot.position, 2);
  assert.deepEqual(first.value.snapshot.selectedAnswers, snapshot.selectedAnswers);
  assert.deepEqual(sessionSummary(first.value.snapshot.session), {
    total: 3, answered: 2, correct: 2, incorrect: 0,
    skipped: 1, corrected: 1, reinforced: 1, complete: false,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(readSessionSummary(storage), {
    position: 3, total: 3, context: snapshot.context,
  });
});

test("отбрасывает повреждённую и устаревшую структуру", () => {
  const original = saved();
  const cases = [
    { ...original, version: 0 },
    { ...original, ticketIds: [3, 3, 2] },
    { ...original, ticketIds: [3, 1, 999] },
    { ...original, position: 3 },
    { ...original, sessionStarted: false },
    { ...original, context: { ...original.context, topicId: "999" } },
    { ...original, selectedAnswers: { ...original.selectedAnswers, 3: { index: 8, outcome: { corrected: false, reinforced: false } } } },
    { ...original, session: { ...original.session, answers: { ...original.session.answers, 1: { correct: false, corrected: true, reinforced: true } } } },
  ];
  for (const damaged of cases) {
    assert.equal(validateSessionSnapshot(damaged, bank, sets, topics), null);
  }
  const changedBank = bank.map((ticket) => ticket.id === 2
    ? { ...ticket, answers: ["Нет", "Да"] } : ticket);
  assert.equal(validateSessionSnapshot(original, changedBank, sets, topics), null);
});

test("проверяет связь с темой и билетом", () => {
  const snapshot = saved();
  assert.equal(validateSessionSnapshot(snapshot, bank, sets, [{ id: 19, ticket_ids: [1, 2] }]), null);
  assert.equal(validateSessionSnapshot({ ...snapshot, context: { ...snapshot.context, set: 2 } }, bank, sets, topics), null);
});

test("ошибка чтения и записи хранилища не бросает исключение", () => {
  const denied = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.deepEqual(readSession(denied, bank, sets, topics), { status: "unavailable", value: null });
  assert.equal(readSessionSummary(denied), null);
  assert.equal(writeSession(denied, saved()), false);
  assert.equal(discardSession(denied), false);
});

test("завершение и отказ удаляют только снимок занятия", () => {
  const storage = memory();
  storage.setItem("avtoshkola-progress-v1", "старый прогресс");
  writeSession(storage, saved());
  assert.equal(discardSession(storage), true);
  assert.deepEqual(readSession(storage, bank, sets, topics), { status: "missing", value: null });
  assert.equal(storage.getItem("avtoshkola-progress-v1"), "старый прогресс");
  assert.equal(discardSession(storage), true);
});

test("невалидный JSON не мешает новой тренировке", () => {
  const storage = memory();
  storage.setItem(SESSION_STORAGE_KEY, "{");
  assert.deepEqual(readSession(storage, bank, sets, topics), { status: "invalid", value: null });
});

test("явный билет или другой контекст имеет приоритет над resume", () => {
  const savedContext = { filter: "all", query: "", topicId: "19", limit: 20, set: null };
  const requestedContext = { filter: "all", query: "", topicId: "20", set: null };
  assert.equal(shouldRestoreSession(new URLSearchParams("resume=1&topic=20"), savedContext, requestedContext), false);
  assert.equal(shouldRestoreSession(new URLSearchParams("resume=1&ticket=1"), savedContext, savedContext), false);
  assert.equal(shouldRestoreSession(new URLSearchParams("resume=1&set=999"),
    { ...savedContext, topicId: "" }, { filter: "all", query: "", topicId: "", set: null }), false);
  assert.equal(shouldRestoreSession(new URLSearchParams("resume=1&topic=19"), savedContext, savedContext), true);
  assert.equal(shouldRestoreSession(new URLSearchParams("resume=1"), savedContext, requestedContext), true);
  assert.equal(shouldRestoreSession(new URLSearchParams(""), savedContext, savedContext), false);
});

test("удаляет повреждённый снимок только после полной проверки данных", () => {
  const storage = memory();
  storage.setItem(SESSION_STORAGE_KEY, "{");
  assert.deepEqual(readSession(storage, bank, sets, [], { discardInvalid: false }),
    { status: "invalid", value: null });
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), "{");
  assert.deepEqual(readSession(storage, bank, sets, topics, { discardInvalid: true }),
    { status: "invalid", value: null, cleared: true });
  assert.equal(readSessionSummary(storage), null);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
});
