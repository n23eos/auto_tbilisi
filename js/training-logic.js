// Чистая логика тренировки: прогресс, фильтры, навигация. Без DOM.
// Прогресс никогда не меняется на месте — функции возвращают новый объект.

export const STORAGE_KEY = "avtoshkola-progress-v1";

export const FILTERS = {
  ALL: "all",
  UNSOLVED: "unsolved",
  MISTAKES: "mistakes",
};

function emptyProgress() {
  return { solved: [], mistakes: [], position: 0 };
}

function intList(value) {
  return Array.isArray(value) ? value.filter(Number.isInteger) : [];
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

export function markAnswer(progress, ticketId, wasCorrect) {
  const solved = new Set(progress.solved);
  const mistakes = new Set(progress.mistakes);

  if (wasCorrect) {
    solved.add(ticketId);
    mistakes.delete(ticketId);
  } else {
    mistakes.add(ticketId);
    solved.delete(ticketId);
  }

  const asSortedList = (set) => [...set].sort((a, b) => a - b);
  return { ...progress, solved: asSortedList(solved), mistakes: asSortedList(mistakes) };
}

export function filterTickets(tickets, progress, filter) {
  const ru = tickets.filter((ticket) => ticket.lang === "ru");
  if (filter === FILTERS.UNSOLVED) {
    const solved = new Set(progress.solved);
    return ru.filter((ticket) => !solved.has(ticket.id));
  }
  if (filter === FILTERS.MISTAKES) {
    const mistakes = new Set(progress.mistakes);
    return ru.filter((ticket) => mistakes.has(ticket.id));
  }
  return ru;
}

export function clampPosition(position, length) {
  if (length <= 0) return 0;
  if (!Number.isInteger(position) || position < 0) return 0;
  return Math.min(position, length - 1);
}

export function movePosition(position, delta, length) {
  return clampPosition(position + delta, length);
}
