// Интерфейс тренировки. Правила и прогресс - в training-logic.js.

import {
  FILTERS,
  answerOutcome,
  createSession,
  recordSessionAnswer,
  sessionSummary,
  clampPosition,
  markAnswer,
  movePosition,
  progressSummary,
  readProgress,
  selectTrainingTickets,
  toggleFavorite,
  writeProgress,
} from "./training-logic.js?v=4";
import { markAnswerButtons } from "./answer-marking.js";
import { loadTicketBank } from "./ticket-bank.js?v=1";
import { buildTicketSets } from "./ticket-catalog-logic.js?v=1";
import { discardSession, makeSessionSnapshot, readSession, shouldRestoreSession, writeSession } from "./training-session.js?v=1";

const DATA_URL = "../../data/tickets-b-ru.json?v=2";
const TOPICS_URL = "../../data/ticket-topics.json";
const IMAGES_BASE = "../../data/";
const QUESTION_NAV_LIMIT = 40;

const el = (id) => document.getElementById(id);

const state = {
  all: [],
  list: [],
  sets: [],
  ordinals: new Map(),
  selectedSet: null,
  topics: [],
  progress: { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] },
  filter: FILTERS.TODAY,
  query: "",
  topicId: "",
  limit: 20,
  answered: false,
  completed: false,
  storageAvailable: true,
  sessionStorageAvailable: true,
  session: null,
  selectedAnswers: {},
  sessionStarted: false,
  savedSession: null,
};

const EMPTY_TEXT = {
  [FILTERS.TODAY]: "На сегодня всё готово. Возвращайтесь завтра или выберите другой режим.",
  [FILTERS.ALL]: "Доступных вопросов нет.",
  [FILTERS.UNSOLVED]: "Нерешённых вопросов не осталось. Вы прошли все доступные вопросы.",
  [FILTERS.MISTAKES]: "Ошибок пока нет. Они появятся здесь после экзамена или тренировки.",
  [FILTERS.FAVORITES]: "В избранном пока ничего нет. Добавьте вопрос кнопкой со звездой.",
};

function questionWord(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "вопросов";
  if (mod10 === 1) return "вопрос";
  if (mod10 >= 2 && mod10 <= 4) return "вопроса";
  return "вопросов";
}

function store() {
  // localStorage может быть запрещён - тогда работаем без запоминания.
  try {
    return window.localStorage;
  } catch {
    state.storageAvailable = false;
    state.sessionStorageAvailable = false;
    return { getItem: () => null, setItem: () => { throw new Error("хранилище недоступно"); }, removeItem: () => { throw new Error("хранилище недоступно"); } };
  }
}

function renderStorageStatus() {
  const status = el("t-storage-status");
  status.hidden = state.storageAvailable && state.sessionStorageAvailable;
  if (status.hidden) return;
  status.textContent = !state.storageAvailable && !state.sessionStorageAvailable
    ? "Прогресс и занятие не сохраняются: хранилище браузера недоступно."
    : state.storageAvailable
      ? "Занятие не сохраняется: хранилище браузера недоступно или заполнено."
      : "Прогресс не сохраняется: хранилище браузера недоступно или заполнено.";
}

function save() {
  if (!writeProgress(store(), state.progress)) state.storageAvailable = false;
  renderStorageStatus();
}

function snapshot() {
  return makeSessionSnapshot({
    list: state.list,
    position: state.progress.position,
    selectedAnswers: state.selectedAnswers,
    session: state.session,
    sessionStarted: state.sessionStarted,
    filter: state.filter,
    query: state.query,
    topicId: state.topicId,
    limit: state.limit,
    set: state.selectedSet?.number ?? null,
  });
}

function saveSession() {
  if (!state.list.length || state.completed) return false;
  const saved = writeSession(store(), snapshot());
  if (!saved) state.sessionStorageAvailable = false;
  state.savedSession = null;
  el("t-resume").hidden = true;
  renderStorageStatus();
  return saved;
}

function clearSavedSession() {
  if (!discardSession(store())) state.sessionStorageAvailable = false;
  state.savedSession = null;
  el("t-resume").hidden = true;
  renderStorageStatus();
}

function sessionLabel(context) {
  if (context.set !== null) return `Билет ${context.set}`;
  if (context.topicId) return state.topics.find((topic) => String(topic.id) === context.topicId)?.name || "Тема";
  if (context.query) return `Поиск: ${context.query}`;
  return context.filter === FILTERS.TODAY ? "Миссия на сегодня" : "Тренировка";
}

function showResumeOffer() {
  const saved = state.savedSession;
  el("t-resume").hidden = !saved;
  if (!saved) return;
  const { snapshot: previous } = saved;
  el("t-resume-title").textContent = sessionLabel(previous.context);
  el("t-resume-note").textContent = `Продолжить: вопрос ${previous.position + 1} из ${previous.ticketIds.length}. Прежние ответы останутся на месте.`;
}

function restoreSession(saved) {
  const previous = saved.snapshot;
  state.selectedSet = saved.selectedSet;
  state.filter = previous.context.filter;
  state.query = previous.context.query;
  state.topicId = previous.context.topicId;
  state.limit = previous.context.limit;
  state.list = saved.tickets;
  state.session = previous.session;
  state.selectedAnswers = previous.selectedAnswers;
  state.sessionStarted = previous.sessionStarted;
  state.completed = false;
  state.progress = { ...state.progress, position: previous.position };
  el("t-search").value = state.query;
  if (state.topics.length) populateTopics(state.topics);
  el("t-limit").value = String(state.limit);
  renderSetContext();
  renderFilterState();
  renderDashboard();
  renderCard();
  el("t-resume").hidden = true;
  el("t-session-status").textContent = `Занятие восстановлено: вопрос ${previous.position + 1} из ${previous.ticketIds.length}.`;
}

function selectionOptions() {
  return {
    filter: state.filter,
    query: state.query,
    topicId: state.topicId,
    topics: state.topics,
    limit: state.limit,
  };
}

function selectionPool() {
  return state.selectedSet?.tickets || state.all;
}

function renderSetContext() {
  const note = el("t-set-note");
  el("filter-all").textContent = state.selectedSet ? "Весь билет" : "Вся база";
  el("t-exit-set").hidden = !state.selectedSet;
  el("t-general-note").hidden = Boolean(state.selectedSet);
  if (!state.selectedSet) {
    el("t-page-title").textContent = "Тренировка по билетам ПДД";
    note.hidden = true;
    note.textContent = "";
    return;
  }
  el("t-page-title").textContent = `Билет ${state.selectedSet.number}`;
  note.textContent = `Учебная подборка: ${state.selectedSet.tickets.length} ${questionWord(state.selectedSet.tickets.length)}.`;
  note.hidden = false;
}

function renderCounters() {
  const summary = progressSummary(selectionPool(), state.progress);
  const bankSummary = progressSummary(state.all, state.progress);
  el("t-total").textContent = String(state.list.length);
  el("t-index").textContent = String(state.list.length && !state.completed ? state.progress.position + 1 : 0);
  el("t-solved").textContent = String(summary.solved);
  el("t-pool").textContent = String(summary.total);
  el("t-available-count").textContent = String(bankSummary.total);
  el("t-progress").style.width = summary.total ? `${(summary.solved / summary.total) * 100}%` : "0";
}

function renderDashboard() {
  const pool = selectionPool();
  const summary = progressSummary(pool, state.progress);
  const today = selectTrainingTickets(pool, state.progress, {
    ...selectionOptions(),
    filter: FILTERS.TODAY,
  });
  el("t-stat-solved").textContent = String(summary.solved);
  el("t-stat-due").textContent = String(summary.due);
  el("t-stat-remaining").textContent = String(summary.remaining);

  if (state.query || state.topicId || state.selectedSet) {
    el("t-plan-note").textContent = today.length
      ? `В выбранной подборке на сегодня: ${today.length} ${questionWord(today.length)}.`
      : "В выбранной подборке на сегодня нет вопросов.";
  } else if (summary.due > 0) {
    el("t-plan-note").textContent = `Сначала повторите ${summary.due} ${questionWord(summary.due)}, затем переходите к новым.`;
  } else if (summary.remaining > 0) {
    el("t-plan-note").textContent = "Повторений пока нет. Начните с короткой подборки новых вопросов.";
  } else {
    el("t-plan-note").textContent = "Все доступные вопросы решены, срочных повторений нет.";
  }
  el("t-start-today").textContent = today.length
    ? `Начать ${today.length} ${questionWord(today.length)}`
    : "Нет вопросов на сегодня";
  el("t-start-today").disabled = today.length === 0;
  el("t-dashboard").hidden = Boolean(state.selectedSet);
}

function track(event, values = {}) {
  if (typeof window.gtag === "function") window.gtag("event", event, { mode: state.filter, ...values });
}

function startSession() {
  state.session = createSession(state.list, state.progress);
  state.selectedAnswers = {};
  state.sessionStarted = false;
}

function renderMission() {
  const summary = sessionSummary(state.session);
  el("t-mission").hidden = !summary.total || state.completed;
  el("t-mission-title").textContent = state.filter === FILTERS.TODAY ? "Миссия на сегодня" : "Ваша подборка";
  el("t-mission-count").textContent = `${summary.answered} / ${summary.total}`;
  el("t-mission-note").textContent = `В подборке: ${summary.total} ${questionWord(summary.total)}. Прошлых ошибок: ${state.session.originalMistakeIds.length}.`;
  el("t-mission-progress").max = Math.max(1, summary.total);
  el("t-mission-progress").value = summary.answered;
}

function showAnswer(ticket, index, outcome = {}) {
  const correct = ticket.correct === index;
  markAnswerButtons(el("t-answers"), ticket.correct, index);
  const feedback = el("t-feedback");
  feedback.textContent = correct ? `Верно: ${ticket.answers[ticket.correct]}` : `Неверно. Правильный ответ: ${ticket.answers[ticket.correct]}`;
  feedback.className = `exam__feedback ${correct ? "exam__feedback--ok" : "exam__feedback--bad"}`;
  const reward = el("t-answer-reward");
  reward.hidden = !outcome.corrected && !outcome.reinforced;
  reward.textContent = outcome.reinforced
    ? "★ Вспомнили после паузы! Верный ответ на прежнюю ошибку после паузы минимум сутки."
    : "✓ Исправили прошлую ошибку. Повторим после паузы, чтобы закрепить.";
}

function renderResult() {
  const summary = sessionSummary(state.session);
  el("t-result").hidden = false;
  el("t-result-done").textContent = "На сегодня хватит";
  el("t-result-next").removeAttribute("role");
  el("t-result-title").textContent = summary.complete ? "Миссия выполнена" : "Подборка просмотрена";
  el("t-result-mark").textContent = summary.complete ? "✓" : "→";
  el("t-result").classList.toggle("training-result--complete", summary.complete);
  el("t-result-note").textContent = state.storageAvailable
    ? `Ответили на ${summary.answered} из ${summary.total}. Прогресс сохранён в этом браузере.`
    : `Ответили на ${summary.answered} из ${summary.total}. Прогресс доступен только до закрытия страницы.`;
  for (const key of ["correct", "incorrect", "skipped"]) el(`t-result-${key}`).textContent = summary[key];
  el("t-result-corrections").textContent = summary.corrected
    ? `Исправлено прошлых ошибок: ${summary.corrected}. Это шаг вперёд.`
    : summary.incorrect
      ? "Ошибки помогают выбрать, что повторить. Верный ответ сразу после подсказки ещё нужно закрепить."
      : summary.answered
        ? "Верные ответы - хороший результат. Повторение после паузы поможет сохранить его."
        : "В этот раз вы только просмотрели вопросы. Можно вернуться к ним, когда будете готовы.";
  el("t-result-reward").hidden = summary.reinforced === 0;
  el("t-result-reward").textContent = `★ Вспомнили после паузы: ${summary.reinforced}. Вы верно ответили на прежние ошибки спустя минимум сутки.`;
  el("t-result-next").textContent = summary.incorrect || summary.skipped
    ? "Можно закончить сейчас или отдельно разобрать ошибки и пропуски."
    : "Хорошая точка для паузы. Возвращайтесь завтра: подборка предложит вопросы на повторение.";
  el("t-result-retry").hidden = !summary.incorrect && !summary.skipped;
}

function renderFilterState() {
  document.querySelectorAll(".exam__filters [data-filter]").forEach((button) => {
    const isActive = button.dataset.filter === state.filter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  el("t-clear-filters").hidden = !state.query && !state.topicId;
}

function renderEmpty() {
  const empty = el("t-empty");
  const action = el("t-empty-action");
  empty.hidden = false;

  if (state.completed) {
    el("t-empty-text").textContent = state.storageAvailable
      ? "Сессия завершена. Ответы сохранены в вашем прогрессе."
      : "Сессия завершена. Ответы останутся только до закрытия страницы.";
    action.textContent = "Пройти эту подборку ещё раз";
    action.hidden = false;
    return;
  }

  if (state.query || state.topicId) {
    el("t-empty-text").textContent = "По выбранным условиям вопросов не найдено. Попробуйте другой запрос или сбросьте поиск и тему.";
    action.textContent = "Сбросить поиск и тему";
    action.hidden = false;
    return;
  }

  el("t-empty-text").textContent = EMPTY_TEXT[state.filter] || EMPTY_TEXT[FILTERS.ALL];
  action.hidden = true;
}

function ticketPermalink(ticketId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (state.selectedSet) url.searchParams.set("set", String(state.selectedSet.number));
  url.searchParams.set("ticket", String(ticketId));
  return url.href;
}

function helpLink(ticketId) {
  const url = new URL("../../", window.location.href);
  url.searchParams.set("from", "training");
  url.searchParams.set("goal", "theory");
  url.searchParams.set("ticket", String(ticketId));
  url.hash = "callback-form";
  return url.href;
}

function renderFavoriteButton(ticketId) {
  const isFavorite = (state.progress.favorites || []).includes(ticketId);
  const favorite = el("t-favorite");
  favorite.textContent = isFavorite ? "★ В избранном" : "☆ В избранное";
  favorite.setAttribute("aria-pressed", String(isFavorite));
}

function jumpToQuestion(position) {
  if (state.completed || position < 0 || position >= state.list.length) return;
  state.progress = { ...state.progress, position };
  save();
  saveSession();
  renderCard({ focusQuestion: true });
}

function renderQuestionNavigator() {
  const nav = el("t-question-nav");
  const grid = el("t-question-nav-grid");
  const visible = !state.completed && state.list.length > 1 && state.list.length <= QUESTION_NAV_LIMIT;
  nav.hidden = !visible;
  grid.textContent = "";
  if (!visible) return;

  state.list.forEach((ticket, index) => {
    const current = index === state.progress.position;
    const answered = Object.prototype.hasOwnProperty.call(state.selectedAnswers, ticket.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "exam__filter learning-question-nav__button";
    button.classList.toggle("is-active", current);
    button.classList.toggle("is-answered", answered);
    button.textContent = `${index + 1}${answered ? " ✓" : ""}`;
    button.setAttribute("aria-label", `Вопрос ${index + 1}${current ? ", текущий" : ""}${answered ? ", отвечен" : ""}`);
    if (current) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => jumpToQuestion(index));
    grid.append(button);
  });
}

function renderCard({ focusQuestion = false } = {}) {
  const ticket = state.completed ? null : state.list[state.progress.position];
  state.answered = false;
  el("t-result").hidden = true;
  el("t-answer-reward").hidden = true;
  renderMission();

  el("t-empty").hidden = Boolean(ticket);
  el("t-card").hidden = !ticket;
  el("t-help").hidden = !ticket;
  renderCounters();
  renderQuestionNavigator();

  if (state.completed) {
    el("t-empty").hidden = true;
    renderResult();
    return;
  }

  if (!ticket) {
    renderEmpty();
    return;
  }

  const question = el("t-text");
  question.textContent = ticket.question;

  const figure = el("t-figure");
  if (ticket.image) {
    const imageUrl = IMAGES_BASE + ticket.image;
    el("t-image").src = imageUrl;
    el("t-image-large").src = imageUrl;
    figure.hidden = false;
  } else {
    el("t-image").removeAttribute("src");
    el("t-image-large").removeAttribute("src");
    figure.hidden = true;
  }

  el("t-source-id").textContent = String(ticket.id);
  el("t-catalog-number").textContent = String(state.ordinals.get(ticket.id));
  el("t-help-id").textContent = String(ticket.id);
  el("t-permalink").href = ticketPermalink(ticket.id);
  el("t-help-link").href = helpLink(ticket.id);
  const sourceLink = el("t-source-link");
  try {
    const source = new URL(ticket.source);
    if (source.protocol !== "https:" || source.hostname !== "teoria.on.ge") throw new Error("неизвестный источник");
    sourceLink.href = source.href;
    sourceLink.hidden = false;
  } catch {
    sourceLink.removeAttribute("href");
    sourceLink.hidden = true;
  }

  renderFavoriteButton(ticket.id);

  const list = el("t-answers");
  list.textContent = "";
  ticket.answers.forEach((text, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "exam__answer";
    button.dataset.index = String(index);

    const num = document.createElement("span");
    num.className = "exam__answer-num";
    num.textContent = String(index + 1);

    const label = document.createElement("span");
    label.textContent = text;

    button.append(num, label);
    button.addEventListener("click", () => answer(index));
    item.append(button);
    list.append(item);
  });

  const feedback = el("t-feedback");
  feedback.textContent = "";
  feedback.className = "exam__feedback";

  const atEnd = state.progress.position >= state.list.length - 1;
  el("t-prev").disabled = state.progress.position === 0;
  el("t-next").disabled = false;
  el("t-next").textContent = atEnd
    ? (state.filter === FILTERS.TODAY ? "Завершить сессию" : "Завершить просмотр")
    : "Дальше →";
  const previous = state.selectedAnswers[ticket.id];
  if (previous) {
    state.answered = true;
    showAnswer(ticket, previous.index, previous.outcome);
  }
  if (focusQuestion) question.focus();
}

function answer(index) {
  if (state.answered) return;
  state.answered = true;

  const ticket = state.list[state.progress.position];
  const correct = ticket.correct === index;

  const now = Date.now();
  const outcome = answerOutcome(state.progress, ticket.id, correct, now);
  if (!state.sessionStarted) {
    state.sessionStarted = true;
    track("training_session_start", { total: state.list.length });
  }
  state.selectedAnswers[ticket.id] = { index, outcome };
  state.session = recordSessionAnswer(state.session, ticket.id, correct, outcome);
  state.progress = markAnswer(state.progress, ticket.id, correct, now);
  showAnswer(ticket, index, outcome);
  renderMission();
  renderQuestionNavigator();
  if (outcome.reinforced) track("training_reinforced");
  save();
  saveSession();
  renderCounters();
  renderDashboard();
  if (state.topics.length) populateTopics(state.topics);
  if (typeof window.gtag === "function") {
    window.gtag("event", "training_answer", { correct, mode: state.filter });
  }
}

function finishSession() {
  if (state.completed || !state.list.length) return;
  state.completed = true;
  clearSavedSession();
  const summary = sessionSummary(state.session);
  track(summary.complete ? "training_session_complete" : "training_session_reviewed", summary);
  renderCard();
  el("t-result-title").focus({ preventScroll: true });
  el("t-result").scrollIntoView({ block: "start" });
}

function go(delta) {
  if (state.completed || !state.list.length) return;
  const atEnd = state.progress.position >= state.list.length - 1;
  if (delta > 0 && atEnd) {
    finishSession();
    return;
  }
  state.progress = {
    ...state.progress,
    position: movePosition(state.progress.position, delta, state.list.length),
  };
  save();
  saveSession();
  renderCard({ focusQuestion: true });
}

function applySelection({ resetPosition = true, focusQuestion = false, persist = true } = {}) {
  state.list = selectTrainingTickets(selectionPool(), state.progress, selectionOptions());
  state.completed = false;
  startSession();
  state.progress = {
    ...state.progress,
    position: resetPosition ? 0 : clampPosition(state.progress.position, state.list.length),
  };
  renderFilterState();
  renderDashboard();
  save();
  if (persist) {
    state.savedSession = null;
    el("t-resume").hidden = true;
    if (saveSession()) {
      const url = new URL(window.location.href);
      url.search = "?resume=1";
      window.history.replaceState(null, "", url);
    }
  }
  renderCard({ focusQuestion });
}

function applyFilter(filter) {
  state.filter = filter;
  applySelection();
}

function clearSelectedSet() {
  if (!state.selectedSet) return;
  state.selectedSet = null;
  const url = new URL(window.location.href);
  url.searchParams.delete("set");
  window.history.replaceState(null, "", url);
  renderSetContext();
  if (state.topics.length) populateTopics(state.topics);
}

function clearSearchAndTopic() {
  state.query = "";
  state.topicId = "";
  el("t-search").value = "";
  el("t-topic").value = "";
  applySelection();
}

function populateTopics(topics) {
  const select = el("t-topic");
  const selected = state.topicId;
  select.textContent = "";
  select.append(new Option("Все темы", ""));
  const activeIds = new Set(selectionPool().filter((ticket) => ticket.lang === "ru").map((ticket) => ticket.id));
  const solvedIds = new Set((state.progress.solved || []).filter((id) => activeIds.has(id)));
  topics.forEach((topic) => {
    const availableIds = topic.ticket_ids.filter((id) => activeIds.has(id));
    const count = availableIds.length;
    const solved = availableIds.filter((id) => solvedIds.has(id)).length;
    const option = document.createElement("option");
    option.value = String(topic.id);
    option.textContent = count
      ? `${topic.name} - решено ${solved} из ${count}`
      : `${topic.name} - нет доступных вопросов на русском`;
    option.disabled = count === 0;
    select.append(option);
  });
  select.value = selected;
  select.disabled = false;
  el("t-topic-field").hidden = false;
  el("t-topics-status").hidden = true;
}

function topicsUnavailable() {
  el("t-topic").disabled = true;
  el("t-topic-field").hidden = true;
  el("t-topics-status").textContent = "Темы сейчас недоступны. Остальные режимы продолжают работать.";
  el("t-topics-status").hidden = false;
}

document.querySelectorAll(".exam__filters [data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;
    if (!filter) return;
    applyFilter(filter);
    if (typeof window.gtag === "function") {
      window.gtag("event", "training_mode_select", { mode: filter });
    }
  });
});

el("t-exit-set").addEventListener("click", () => {
  clearSelectedSet();
  const url = new URL(window.location.href);
  url.searchParams.delete("ticket");
  window.history.replaceState(null, "", url);
  state.filter = FILTERS.ALL;
  clearSearchAndTopic();
});

el("t-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = el("t-search").value.trim();
  applySelection();
});

el("t-topic").addEventListener("change", () => {
  state.topicId = el("t-topic").value;
  applySelection();
});

el("t-limit").addEventListener("change", () => {
  state.limit = Number(el("t-limit").value) === 10 ? 10 : 20;
  renderDashboard();
  if (state.filter === FILTERS.TODAY) applySelection();
});

el("t-clear-filters").addEventListener("click", clearSearchAndTopic);
el("t-resume-action").addEventListener("click", () => {
  if (!state.savedSession) return;
  restoreSession(state.savedSession);
  const url = new URL(window.location.href);
  url.search = "?resume=1";
  window.history.replaceState(null, "", url);
  el("t-text").focus();
});
el("t-resume-discard").addEventListener("click", () => {
  clearSavedSession();
  applySelection({ persist: false });
  el("t-session-status").textContent = "Начали новую подборку. Прежнее занятие удалено.";
});
el("t-empty-action").addEventListener("click", () => {
  if (state.completed) {
    state.completed = false;
    startSession();
    state.progress = { ...state.progress, position: 0 };
    save();
    saveSession();
    renderCard({ focusQuestion: true });
  } else {
    clearSearchAndTopic();
  }
});

el("t-start-today").addEventListener("click", () => {
  applyFilter(FILTERS.TODAY);
  if (typeof window.gtag === "function") {
    window.gtag("event", "training_mode_select", { mode: FILTERS.TODAY });
  }
  el("t-text").scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
});

el("t-result-done").addEventListener("click", () => {
  el("t-result-next").textContent = state.storageAvailable
    ? "На сегодня всё. Можно закрыть страницу. Ваш прогресс сохранён, продолжим в следующий раз."
    : "На сегодня всё. Сохранение недоступно: после закрытия страницы прогресс будет потерян.";
  el("t-result-next").setAttribute("role", "status");
  el("t-result-done").textContent = "До следующего занятия";
});

el("t-result-retry").addEventListener("click", () => {
  state.list = state.list.filter((ticket) => {
    const answer = state.selectedAnswers[ticket.id];
    return !answer || answer.index !== ticket.correct;
  });
  state.completed = false;
  startSession();
  state.progress = { ...state.progress, position: 0 };
  save();
  saveSession();
  renderCard({ focusQuestion: true });
});

el("t-prev").addEventListener("click", () => go(-1));
el("t-next").addEventListener("click", () => go(1));

el("t-favorite").addEventListener("click", () => {
  const ticket = state.list[state.progress.position];
  if (!ticket) return;
  state.progress = toggleFavorite(state.progress, ticket.id);
  save();
  // Подборка остаётся стабильной до следующего выбора режима:
  // снятие звезды не должно прятать ответ и менять текущий вопрос.
  renderFavoriteButton(ticket.id);
});

const imageDialog = el("t-image-dialog");
let imageTrigger = null;

function openImageDialog() {
  imageTrigger = el("t-image-open");
  if (typeof imageDialog.showModal === "function") imageDialog.showModal();
  else imageDialog.setAttribute("open", "");
  el("t-image-close").focus();
}

function closeImageDialog() {
  if (typeof imageDialog.close === "function" && imageDialog.open) imageDialog.close();
  else imageDialog.removeAttribute("open");
}

el("t-image-open").addEventListener("click", openImageDialog);
el("t-image-close").addEventListener("click", closeImageDialog);
imageDialog.addEventListener("click", (event) => {
  if (event.target === imageDialog) closeImageDialog();
});
imageDialog.addEventListener("close", () => {
  imageTrigger?.focus();
  imageTrigger = null;
});
imageDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && typeof imageDialog.close !== "function") {
    event.preventDefault();
    closeImageDialog();
    imageTrigger?.focus();
    imageTrigger = null;
  }
});

el("t-reset").addEventListener("click", () => {
  if (!window.confirm("Стереть весь прогресс тренировки, включая избранное? Отменить это будет нельзя.")) return;
  state.progress = { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] };
  clearSavedSession();
  save();
  renderDashboard();
  if (state.topics.length) populateTopics(state.topics);
  applySelection({ persist: false });
});

document.addEventListener("keydown", (event) => {
  if (el("t-card").hidden || imageDialog.open || event.defaultPrevented || event.repeat) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target instanceof Element && event.target.closest("form, input, select, textarea, button, a, [contenteditable='true']")) return;

  if (event.key >= "1" && event.key <= "4") {
    const button = el("t-answers").querySelector(`[data-index="${Number(event.key) - 1}"]`);
    if (button && !button.disabled) button.click();
  }
  // Без preventDefault стрелка одновременно меняет билет и прокручивает страницу.
  if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
  if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
});

async function loadTopics() {
  try {
    const response = await fetch(TOPICS_URL);
    if (!response.ok) throw new Error(`код ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.topics) || data.topics.some((topic) => !Array.isArray(topic.ticket_ids))) {
      throw new Error("неверный формат");
    }
    state.topics = data.topics;
    return true;
  } catch {
    state.topics = [];
    topicsUnavailable();
    return false;
  }
}

(async function init() {
  const status = el("t-status");
  try {
    state.all = await loadTicketBank(DATA_URL);
    state.sets = buildTicketSets(state.all);
    state.ordinals = new Map(state.sets.flatMap(set => set.tickets).map((ticket, index) => [ticket.id, index + 1]));
    state.progress = readProgress(store());
    const topicsLoaded = await loadTopics();

    const parameters = new URLSearchParams(window.location.search);
    const requestedSet = parameters.get("set");
    if (requestedSet && /^[1-9]\d*$/.test(requestedSet)) {
      state.selectedSet = state.sets.find((set) => set.number === Number(requestedSet)) || null;
      if (state.selectedSet) state.filter = FILTERS.ALL;
    }
    renderSetContext();

    const requestedTicket = parameters.get("ticket");
    if (requestedTicket && /^\d+$/.test(requestedTicket)) {
      state.filter = FILTERS.ALL;
      state.query = requestedTicket;
      el("t-search").value = requestedTicket;
    }

    const requestedTopic = parameters.get("topic");
    if (requestedTopic && topicsLoaded) {
      const topic = state.topics.find((item) => String(item.id) === requestedTopic);
      if (topic) {
        state.topicId = requestedTopic;
        state.filter = FILTERS.ALL;
      } else {
        el("t-session-status").textContent = "Эта тема не найдена. Показываем обычную тренировку.";
      }
    } else if (requestedTopic) {
      el("t-session-status").textContent = "Темы сейчас недоступны. Показываем обычную тренировку.";
    }
    if (topicsLoaded) populateTopics(state.topics);

    const saved = readSession(store(), state.all, state.sets, state.topics, { discardInvalid: topicsLoaded });
    if (saved.status === "ok") state.savedSession = saved.value;
    if (saved.status === "unavailable") {
      state.sessionStorageAvailable = false;
      renderStorageStatus();
    }
    if (saved.status === "invalid" && topicsLoaded) {
      if (!saved.cleared) {
        state.sessionStorageAvailable = false;
        renderStorageStatus();
      }
      el("t-session-status").textContent = "Прежнее занятие устарело или повреждено. Можно начать новую подборку.";
    }

    status.hidden = true;
    const explicit = parameters.has("set") || parameters.has("ticket") || parameters.has("topic");
    const canRestore = shouldRestoreSession(parameters, state.savedSession?.snapshot.context, {
      filter: state.filter,
      query: state.query,
      topicId: state.topicId,
      set: state.selectedSet?.number ?? null,
    });
    if (canRestore) restoreSession(state.savedSession);
    else {
      applySelection({ resetPosition: true, focusQuestion: false, persist: false });
      if (!explicit) showResumeOffer();
    }
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
    topicsUnavailable();
  }
})();
