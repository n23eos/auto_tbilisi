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

function reviewMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const reviews = {};
  Object.entries(value).forEach(([key, review]) => {
    const id = Number(key);
    if (!Number.isInteger(id) || !review || typeof review !== "object") return;
    reviews[id] = {
      attempts: Number.isInteger(review.attempts) && review.attempts >= 0 ? review.attempts : 0,
      streak: Number.isInteger(review.streak) && review.streak >= 0 ? review.streak : 0,
      lastAnsweredAt: Number.isFinite(review.lastAnsweredAt) ? review.lastAnsweredAt : 0,
      nextReviewAt: Number.isFinite(review.nextReviewAt) ? review.nextReviewAt : 0,
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

export function markAnswer(progress, ticketId, wasCorrect, now = Date.now()) {
  const solved = new Set(progress.solved);
  const mistakes = new Set(progress.mistakes);
  const reviews = { ...(progress.reviews || {}) };
  const previous = reviews[ticketId] || { attempts: 0, streak: 0 };

  if (wasCorrect) {
    solved.add(ticketId);
    mistakes.delete(ticketId);
  } else {
    mistakes.add(ticketId);
    solved.delete(ticketId);
  }

  const streak = wasCorrect ? previous.streak + 1 : 0;
  const intervalIndex = Math.min(Math.max(streak - 1, 0), REVIEW_INTERVAL_DAYS.length - 1);
  reviews[ticketId] = {
    attempts: previous.attempts + 1,
    streak,
    lastAnsweredAt: now,
    nextReviewAt: wasCorrect ? now + REVIEW_INTERVAL_DAYS[intervalIndex] * DAY_MS : now,
  };

  const asSortedList = (set) => [...set].sort((a, b) => a - b);
  return { ...progress, solved: asSortedList(solved), mistakes: asSortedList(mistakes), reviews };
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
