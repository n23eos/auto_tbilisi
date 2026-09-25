// Снимок незавершённой тренировки хранится отдельно от долгосрочного прогресса.

export const SESSION_STORAGE_KEY = "avtoshkola-training-session-v1";
const VERSION = 1;
const FILTERS = new Set(["today", "all", "unsolved", "mistakes", "favorites"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function booleanOutcome(value) {
  return object(value) && typeof value.corrected === "boolean" && typeof value.reinforced === "boolean";
}

function signature(tickets) {
  // Хеш вопроса и вариантов позволяет обнаружить обновлённые ответы при прежнем ID.
  const value = JSON.stringify(tickets.map(({ id, question, answers, correct, lang }) =>
    [id, question, answers, correct, lang]));
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function makeSessionSnapshot({ list, position, selectedAnswers, session, sessionStarted, filter, query, topicId, limit, set }) {
  return {
    version: VERSION,
    context: { filter, query, topicId, limit, set },
    ticketIds: list.map((ticket) => ticket.id),
    bankSignature: signature(list),
    position,
    selectedAnswers,
    session,
    sessionStarted,
  };
}

export function shouldRestoreSession(parameters, savedContext, requestedContext) {
  if (!savedContext) return false;
  const explicit = parameters.has("set") || parameters.has("ticket") || parameters.has("topic");
  if (!explicit) return parameters.get("resume") === "1";
  // Ссылка на вопрос всегда открывает именно вопрос, даже при совпадении с сохранением.
  if (parameters.has("ticket")) return false;
  if (parameters.has("set") && parameters.get("set") !== String(savedContext.set)) return false;
  if (parameters.has("topic") && parameters.get("topic") !== savedContext.topicId) return false;
  return savedContext.filter === requestedContext.filter
    && savedContext.query === requestedContext.query
    && savedContext.topicId === requestedContext.topicId
    && savedContext.set === requestedContext.set;
}

export function validateSessionSnapshot(snapshot, bank, sets = [], topics = []) {
  if (!object(snapshot) || snapshot.version !== VERSION || !object(snapshot.context)) return null;
  const { filter, query, topicId, limit, set } = snapshot.context;
  if (!FILTERS.has(filter) || typeof query !== "string" || typeof topicId !== "string"
      || ![10, 20].includes(limit) || (set !== null && (!Number.isInteger(set) || set <= 0))) return null;
  if (topicId && !topics.some((topic) => String(topic.id) === topicId)) return null;
  const selectedSet = set === null ? null : sets.find((item) => item.number === set);
  if (set !== null && !selectedSet) return null;
  if (!Array.isArray(snapshot.ticketIds) || !snapshot.ticketIds.length
      || snapshot.ticketIds.some((id) => !Number.isInteger(id) || id <= 0)
      || new Set(snapshot.ticketIds).size !== snapshot.ticketIds.length
      || !Number.isInteger(snapshot.position) || snapshot.position < 0
      || snapshot.position >= snapshot.ticketIds.length
      || typeof snapshot.bankSignature !== "string"
      || typeof snapshot.sessionStarted !== "boolean") return null;

  const byId = new Map(bank.map((ticket) => [ticket.id, ticket]));
  const tickets = snapshot.ticketIds.map((id) => byId.get(id));
  if (tickets.some((ticket) => !ticket || ticket.lang !== "ru")
      || signature(tickets) !== snapshot.bankSignature) return null;
  if (selectedSet) {
    const setIds = new Set(selectedSet.tickets.map((ticket) => ticket.id));
    if (snapshot.ticketIds.some((id) => !setIds.has(id))) return null;
  }
  if (topicId) {
    const topic = topics.find((item) => String(item.id) === topicId);
    const topicIds = new Set(topic.ticket_ids);
    if (snapshot.ticketIds.some((id) => !topicIds.has(id))) return null;
  }

  const current = snapshot.session;
  if (!object(current) || !Array.isArray(current.ticketIds)
      || JSON.stringify(current.ticketIds) !== JSON.stringify(snapshot.ticketIds)
      || !Array.isArray(current.originalMistakeIds) || !object(current.answers)
      || !object(snapshot.selectedAnswers)) return null;
  const ids = new Set(snapshot.ticketIds);
  if (new Set(current.originalMistakeIds).size !== current.originalMistakeIds.length
      || current.originalMistakeIds.some((id) => !ids.has(id))) return null;
  const selectedKeys = Object.keys(snapshot.selectedAnswers);
  const answerKeys = Object.keys(current.answers);
  if (selectedKeys.length !== answerKeys.length || !snapshot.sessionStarted && selectedKeys.length > 0) return null;
  for (const key of selectedKeys) {
    const id = Number(key);
    const ticket = byId.get(id);
    const chosen = snapshot.selectedAnswers[key];
    const answer = current.answers[key];
    if (!ids.has(id) || !Object.hasOwn(current.answers, key)
        || !object(chosen) || !Number.isInteger(chosen.index)
        || chosen.index < 0 || chosen.index >= ticket.answers.length
        || !booleanOutcome(chosen.outcome) || !object(answer)
        || typeof answer.correct !== "boolean" || typeof answer.corrected !== "boolean"
        || typeof answer.reinforced !== "boolean"
        || answer.correct !== (chosen.index === ticket.correct)
        || answer.corrected !== (answer.correct && current.originalMistakeIds.includes(id))
        || answer.reinforced !== (answer.correct && chosen.outcome.reinforced)
        || chosen.outcome.corrected !== answer.corrected) return null;
  }
  return { snapshot, tickets, selectedSet };
}

function invalidSession(storage, discardInvalid) {
  if (!discardInvalid) return { status: "invalid", value: null };
  return { status: "invalid", value: null, cleared: discardSession(storage) };
}

export function readSession(storage, bank, sets = [], topics = [], { discardInvalid = false } = {}) {
  let raw;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return { status: "unavailable", value: null };
  }
  if (raw === null) return { status: "missing", value: null };
  try {
    const parsed = JSON.parse(raw);
    const value = validateSessionSnapshot(parsed, bank, sets, topics);
    return value ? { status: "ok", value } : invalidSession(storage, discardInvalid);
  } catch {
    return invalidSession(storage, discardInvalid);
  }
}

// Каталог может показать приглашение без загрузки банка; тренировка проверит снимок полностью.
export function readSessionSummary(storage) {
  try {
    const snapshot = JSON.parse(storage.getItem(SESSION_STORAGE_KEY));
    if (!object(snapshot) || snapshot.version !== VERSION || !object(snapshot.context)
        || !Array.isArray(snapshot.ticketIds) || !snapshot.ticketIds.length
        || !Number.isInteger(snapshot.position) || snapshot.position < 0
        || snapshot.position >= snapshot.ticketIds.length) return null;
    return { position: snapshot.position + 1, total: snapshot.ticketIds.length, context: snapshot.context };
  } catch {
    return null;
  }
}

export function writeSession(storage, snapshot) {
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function discardSession(storage) {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
