// Чистая логика экзамена: ни одного обращения к DOM.
// Отделена от интерфейса ровно затем, чтобы её можно было проверить
// в node --test без браузера.

export const QUESTION_COUNT = 30;
// Порог по данным самой автошколы, которая возит учеников на экзамен.
// В коде teoria.on.ge зашито другое правило (провал при >10% ошибок, то есть
// 3 ошибки из 30), но их сайт мог отстать от текущего регламента.
export const MAX_MISTAKES = 5;
export const TIME_LIMIT_SEC = 30 * 60;

/**
 * Случайные билеты для одной попытки.
 * Грузинские билеты отсеиваются: ученик не должен получить вопрос,
 * который не может прочитать.
 */
export function selectExamTickets(tickets, random = Math.random) {
  // Статус 23 спорных билетов не подтверждён официальным банком, поэтому
  // показываем весь каталог источника и сохраняем пометку лишь для сверки.
  const pool = tickets.filter((ticket) => ticket.lang === "ru");
  if (pool.length < QUESTION_COUNT) {
    throw new Error(`русских билетов ${pool.length}, нужно минимум ${QUESTION_COUNT}`);
  }

  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, QUESTION_COUNT);
}

export function isCorrect(ticket, answerIndex) {
  return ticket.correct === answerIndex;
}

/**
 * Ответы хранятся отдельно от DOM, чтобы переход между вопросами не стирал
 * уже выбранный вариант и не позволял повторно засчитать тот же вопрос.
 */
export function createExamAnswers(count = QUESTION_COUNT) {
  return Array.from({ length: count }, () => null);
}

export function recordExamAnswer(answers, questionIndex, chosen, correctIndex) {
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= answers.length) {
    throw new RangeError("вопрос вне экзамена");
  }
  if (answers[questionIndex] !== null) {
    return { answers, recorded: false };
  }

  const nextAnswers = answers.slice();
  nextAnswers[questionIndex] = {
    chosen,
    correct: chosen === correctIndex,
  };
  return { answers: nextAnswers, recorded: true };
}

export function examProgress(answers) {
  return answers.reduce(
    (progress, answer) => {
      if (answer === null) return progress;
      progress.answered += 1;
      if (!answer.correct) progress.mistakes += 1;
      return progress;
    },
    { answered: 0, mistakes: 0 }
  );
}

/**
 * Ищет следующий вопрос без ответа по кругу. Благодаря обходу по кругу
 * пропущенный вопрос снова появится после остальных, а не потеряется.
 */
export function nextUnansweredIndex(answers, currentIndex) {
  for (let offset = 1; offset <= answers.length; offset += 1) {
    const index = (currentIndex + offset) % answers.length;
    if (answers[index] === null) return index;
  }
  return -1;
}

export function isExamTerminal({ answered, mistakes }) {
  return answered >= QUESTION_COUNT || mistakes > MAX_MISTAKES;
}

/**
 * Итог попытки. Правила: QUESTION_COUNT вопросов, не больше MAX_MISTAKES
 * ошибок, не уложился по времени — не сдал. Числа берём из констант выше,
 * а не из текста комментария: раньше здесь было зашито «максимум 3 ошибки»,
 * и докстринг противоречил MAX_MISTAKES = 5.
 */
export function examVerdict({ answered, mistakes, timeUp }) {
  if (mistakes > MAX_MISTAKES) {
    return { passed: false, reason: "mistakes" };
  }
  if (answered < QUESTION_COUNT) {
    return { passed: false, reason: timeUp ? "time" : "unfinished" };
  }
  return { passed: true, reason: "completed" };
}

export function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(safe / 60)).padStart(2, "0");
  const rest = String(safe % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}
