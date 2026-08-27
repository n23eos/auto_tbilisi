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
  // Изъятые из официального банка вопросы ученику показывать незачем.
  const pool = tickets.filter((ticket) => ticket.lang === "ru" && !ticket.withdrawn);
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
 * Итог попытки. Правила настоящего экзамена: 30 вопросов, максимум 3 ошибки,
 * не уложился по времени — не сдал.
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
