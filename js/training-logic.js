// Чистая логика тренировки: прогресс, фильтры, навигация. Без DOM.
// Прогресс никогда не меняется на месте — функции возвращают новый объект.

export const STORAGE_KEY = "avtoshkola-progress-v1";

export const FILTERS = {
  TODAY: "today",
  ALL: "all",
  UNSOLVED: "unsolved",
  MISTAKES: "mistakes",
  FAVORITES: "favorites",
};

export const DAILY_SESSION_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30];

function emptyProgress() {
  return { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] };
}

function intList(value) {
  return Array.isArray(value) ? value.filter(Number.isInteger) : [];
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeTime(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function reviewMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const reviews = {};
  Object.entries(value).forEach(([key, review]) => {
    const id = Number(key);
    if (!Number.isInteger(id) || !review || typeof review !== "object") return;
    reviews[id] = {
      attempts: nonNegativeInteger(review.attempts),
      streak: nonNegativeInteger(review.streak),
      lastAnsweredAt: nonNegativeTime(review.lastAnsweredAt),
      nextReviewAt: nonNegativeTime(review.nextReviewAt),
      lastWrongAt: nonNegativeTime(review.lastWrongAt),
      reinforcedAt: nonNegativeTime(review.reinforcedAt),
    };
  });
  return reviews;
}

/**
 * Прочитать прогресс. Хранилище может быть недоступно (приватный режим,
 * запрет в настройках) и может бросать исключение — тогда тренировка просто
 * идёт без запоминания, а не падает.
 */
export function readProgress(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyProgress();
    const parsed = JSON.parse(raw);
    return {
      solved: intList(parsed.solved),
      mistakes: intList(parsed.mistakes),
      position: Number.isInteger(parsed.position) ? parsed.position : 0,
      reviews: reviewMap(parsed.reviews),
      favorites: [...new Set(intList(parsed.favorites))],
    };
  } catch {
    return emptyProgress();
  }
}

export function writeProgress(storage, progress) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

export function answerOutcome(progress, ticketId, wasCorrect, now = Date.now()) {
  if (!wasCorrect) return { corrected: false, reinforced: false };

  const review = progress.reviews?.[ticketId];
  const lastWrongAt = nonNegativeTime(review?.lastWrongAt);
  const lastAnsweredAt = nonNegativeTime(review?.lastAnsweredAt);
  const reinforcedAt = nonNegativeTime(review?.reinforcedAt);
  const corrected = intList(progress.mistakes).includes(ticketId);
  const reinforced = lastWrongAt > 0
    && now - lastWrongAt >= DAY_MS
    && now - lastAnsweredAt >= DAY_MS
    && reinforcedAt < lastWrongAt;
  return { corrected, reinforced };
}

export function markAnswer(progress, ticketId, wasCorrect, now = Date.now()) {
  const solved = new Set(progress.solved);
  const mistakes = new Set(progress.mistakes);
  const reviews = { ...(progress.reviews || {}) };
  const previous = reviews[ticketId] || {};
  const attempts = nonNegativeInteger(previous.attempts);
  const previousStreak = nonNegativeInteger(previous.streak);
  const previousReviewAt = nonNegativeTime(previous.nextReviewAt);
  const outcome = answerOutcome(progress, ticketId, wasCorrect, now);

  if (wasCorrect) {
    solved.add(ticketId);
    mistakes.delete(ticketId);
  } else {
    mistakes.add(ticketId);
    solved.delete(ticketId);
  }

  const beforeDue = wasCorrect && previousReviewAt > now;
  const streak = wasCorrect && !beforeDue ? previousStreak + 1 : wasCorrect ? previousStreak : 0;
  const intervalIndex = Math.min(Math.max(streak - 1, 0), REVIEW_INTERVAL_DAYS.length - 1);
  reviews[ticketId] = {
    ...previous,
    attempts: attempts + 1,
    streak,
    lastAnsweredAt: now,
    nextReviewAt: wasCorrect && !beforeDue
      ? now + REVIEW_INTERVAL_DAYS[intervalIndex] * DAY_MS
      : wasCorrect ? previousReviewAt : now,
    lastWrongAt: wasCorrect ? nonNegativeTime(previous.lastWrongAt) : now,
    reinforcedAt: outcome.reinforced ? now : nonNegativeTime(previous.reinforcedAt),
  };

  const asSortedList = (set) => [...set].sort((a, b) => a - b);
  return { ...progress, solved: asSortedList(solved), mistakes: asSortedList(mistakes), reviews };
}

function freezeSession(session) {
  Object.freeze(session.ticketIds);
  Object.freeze(session.originalMistakeIds);
  Object.values(session.answers).forEach(Object.freeze);
  Object.freeze(session.answers);
  return Object.freeze(session);
}

export function createSession(tickets, progress) {
  const ticketIds = [...new Set(tickets.map((ticket) => ticket.id).filter(Number.isInteger))];
  const mistakes = new Set(intList(progress.mistakes));
  return freezeSession({
    ticketIds,
    originalMistakeIds: ticketIds.filter((id) => mistakes.has(id)),
    answers: {},
  });
}

export function recordSessionAnswer(session, ticketId, wasCorrect, outcome = {}) {
  if (!session.ticketIds.includes(ticketId)
      || Object.prototype.hasOwnProperty.call(session.answers, ticketId)) {
    return session;
  }

  const originalMistake = session.originalMistakeIds.includes(ticketId);
  return freezeSession({
    ticketIds: [...session.ticketIds],
    originalMistakeIds: [...session.originalMistakeIds],
    answers: {
      ...session.answers,
      [ticketId]: {
        correct: wasCorrect === true,
        corrected: wasCorrect === true && originalMistake,
        reinforced: wasCorrect === true && outcome.reinforced === true,
      },
    },
  });
}

export function sessionSummary(session) {
  const answers = Object.values(session.answers);
  const correct = answers.filter((answer) => answer.correct).length;
  const answered = answers.length;
  const total = session.ticketIds.length;
  return {
    total,
    answered,
    correct,
    incorrect: answered - correct,
    skipped: total - answered,
    corrected: answers.filter((answer) => answer.corrected).length,
    reinforced: answers.filter((answer) => answer.reinforced).length,
    complete: answered === total,
  };
}

function activeTickets(tickets) {
  return tickets.filter((ticket) => ticket.lang === "ru");
}

function dueTickets(tickets, progress, now) {
  const mistakes = new Set(progress.mistakes);
  const reviews = progress.reviews || {};
  return tickets.filter((ticket) => {
    const review = reviews[ticket.id];
    return mistakes.has(ticket.id) || (review && review.nextReviewAt > 0 && review.nextReviewAt <= now);
  });
}

export function buildDailySession(tickets, progress, now = Date.now(), limit = DAILY_SESSION_SIZE) {
  const active = activeTickets(tickets);
  const due = dueTickets(active, progress, now);
  const selected = new Set(due.map((ticket) => ticket.id));
  const solved = new Set(progress.solved);
  const unsolved = active.filter((ticket) => !selected.has(ticket.id) && !solved.has(ticket.id));
  return [...due, ...unsolved].slice(0, Math.max(0, limit));
}

export function progressSummary(tickets, progress, now = Date.now()) {
  const active = activeTickets(tickets);
  const activeIds = new Set(active.map((ticket) => ticket.id));
  const solved = new Set(progress.solved.filter((id) => activeIds.has(id)));
  const mistakes = new Set(progress.mistakes.filter((id) => activeIds.has(id)));
  return {
    total: active.length,
    solved: solved.size,
    due: dueTickets(active, progress, now).length,
    remaining: active.filter((ticket) => !solved.has(ticket.id)).length,
    mistakes: mistakes.size,
  };
}

export function filterTickets(tickets, progress, filter, now = Date.now()) {
  // Пометки спорных вопросов не определяют состав каталога для тренировки.
  const ru = activeTickets(tickets);
  if (filter === FILTERS.TODAY) {
    return buildDailySession(ru, progress, now);
  }
  if (filter === FILTERS.UNSOLVED) {
    const solved = new Set(progress.solved);
    return ru.filter((ticket) => !solved.has(ticket.id));
  }
  if (filter === FILTERS.MISTAKES) {
    const mistakes = new Set(progress.mistakes);
    return ru.filter((ticket) => mistakes.has(ticket.id));
  }
  if (filter === FILTERS.FAVORITES) {
    const favorites = new Set(progress.favorites || []);
    return ru.filter((ticket) => favorites.has(ticket.id));
  }
  return ru;
}

export function toggleFavorite(progress, ticketId) {
  const favorites = new Set(progress.favorites || []);
  if (favorites.has(ticketId)) favorites.delete(ticketId);
  else favorites.add(ticketId);
  return { ...progress, favorites: [...favorites].sort((a, b) => a - b) };
}

/** Отбор по теме и поиску до ограничения сессии: иначе нужный билет
 * мог оказаться за пределами первых двадцати и ошибочно исчезнуть из поиска. */
export function selectTrainingTickets(tickets, progress, options = {}, now = Date.now()) {
  const { filter = FILTERS.ALL, query = "", topicId = "", topics = [], limit = DAILY_SESSION_SIZE } = options;
  let pool = tickets;
  if (topicId !== "" && topicId != null) {
    const topic = topics.find((item) => String(item.id) === String(topicId));
    const ids = new Set(topic?.ticket_ids || []);
    pool = pool.filter((ticket) => ids.has(ticket.id));
  }
  const normalize = (text) => String(text).toLocaleLowerCase("ru").replaceAll("ё", "е");
  const search = normalize(query).trim();
  if (search) {
    if (/^#?\d+$/.test(search)) {
      const id = Number(search.replace(/^#/, ""));
      pool = pool.filter((ticket) => ticket.id === id);
    } else {
      const words = search.split(/\s+/);
      pool = pool.filter((ticket) => words.every((word) => normalize(ticket.question || "").includes(word)));
    }
  }
  if (filter === FILTERS.TODAY) {
    return buildDailySession(pool, progress, now, limit === 10 ? 10 : 20);
  }
  return filterTickets(pool, progress, filter, now);
}

export function clampPosition(position, length) {
  if (length <= 0) return 0;
  if (!Number.isInteger(position) || position < 0) return 0;
  return Math.min(position, length - 1);
}

export function movePosition(position, delta, length) {
  return clampPosition(position + delta, length);
}
