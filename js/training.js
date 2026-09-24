// Интерфейс тренировки. Правила и прогресс - в training-logic.js.

import {
  FILTERS,
  clampPosition,
  markAnswer,
  movePosition,
  progressSummary,
  readProgress,
  selectTrainingTickets,
  toggleFavorite,
  writeProgress,
} from "./training-logic.js?v=2";
import { markAnswerButtons } from "./answer-marking.js";
import { loadTicketBank } from "./ticket-bank.js?v=1";

const DATA_URL = "../../data/tickets-b-ru.json?v=2";
const TOPICS_URL = "../../data/ticket-topics.json";
const IMAGES_BASE = "../../data/";

const el = (id) => document.getElementById(id);

const state = {
  all: [],
  list: [],
  topics: [],
  progress: { solved: [], mistakes: [], position: 0, reviews: {}, favorites: [] },
  filter: FILTERS.TODAY,
  query: "",
  topicId: "",
  limit: 20,
  answered: false,
  completed: false,
  storageAvailable: true,
};

const EMPTY_TEXT = {
  [FILTERS.TODAY]: "На сегодня всё готово. Возвращайтесь завтра или выберите другой режим.",
  [FILTERS.ALL]: "Доступных билетов нет.",
  [FILTERS.UNSOLVED]: "Нерешённых билетов не осталось. Вы прошли все доступные вопросы.",
  [FILTERS.MISTAKES]: "Ошибок пока нет. Они появятся здесь после экзамена или тренировки.",
  [FILTERS.FAVORITES]: "В избранном пока ничего нет. Добавьте билет кнопкой со звездой.",
};

function ticketWord(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "билетов";
  if (mod10 === 1) return "билет";
  if (mod10 >= 2 && mod10 <= 4) return "билета";
  return "билетов";
}

function store() {
  // localStorage может быть запрещён - тогда работаем без запоминания.
  try {
    return window.localStorage;
  } catch {
    state.storageAvailable = false;
    return { getItem: () => null, setItem: () => { throw new Error("хранилище недоступно"); } };
  }
}

function save() {
  if (!writeProgress(store(), state.progress)) state.storageAvailable = false;
  el("t-storage-status").hidden = state.storageAvailable;
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

function renderCounters() {
  const summary = progressSummary(state.all, state.progress);
  el("t-total").textContent = String(state.list.length);
  el("t-index").textContent = String(state.list.length && !state.completed ? state.progress.position + 1 : 0);
  el("t-solved").textContent = String(summary.solved);
  el("t-pool").textContent = String(summary.total);
  el("t-available-count").textContent = String(summary.total);
  el("t-progress").style.width = summary.total ? `${(summary.solved / summary.total) * 100}%` : "0";
}

function renderDashboard() {
  const summary = progressSummary(state.all, state.progress);
  const today = selectTrainingTickets(state.all, state.progress, {
    ...selectionOptions(),
    filter: FILTERS.TODAY,
  });
  el("t-stat-solved").textContent = String(summary.solved);
  el("t-stat-due").textContent = String(summary.due);
  el("t-stat-remaining").textContent = String(summary.remaining);

  if (state.query || state.topicId) {
    el("t-plan-note").textContent = today.length
      ? `В выбранной подборке на сегодня: ${today.length} ${ticketWord(today.length)}.`
      : "В выбранной подборке на сегодня нет вопросов.";
  } else if (summary.due > 0) {
    el("t-plan-note").textContent = `Сначала повторите ${summary.due} ${ticketWord(summary.due)}, затем переходите к новым.`;
  } else if (summary.remaining > 0) {
    el("t-plan-note").textContent = "Повторений пока нет. Начните с короткой подборки новых билетов.";
  } else {
    el("t-plan-note").textContent = "Все доступные билеты решены, срочных повторений нет.";
  }
  el("t-start-today").textContent = today.length
    ? `Начать ${today.length} ${ticketWord(today.length)}`
    : "Нет вопросов на сегодня";
  el("t-start-today").disabled = today.length === 0;
  el("t-dashboard").hidden = false;
}

function renderFilterState() {
  document.querySelectorAll(".exam__filter").forEach((button) => {
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
    el("t-empty-text").textContent = "По выбранным условиям билетов не найдено. Попробуйте другой запрос или сбросьте поиск и тему.";
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

function renderCard({ focusQuestion = false } = {}) {
  const ticket = state.completed ? null : state.list[state.progress.position];
  state.answered = false;

  el("t-empty").hidden = Boolean(ticket);
  el("t-card").hidden = !ticket;
  el("t-help").hidden = !ticket;
  renderCounters();

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
  if (focusQuestion) question.focus();
}

function answer(index) {
  if (state.answered) return;
  state.answered = true;

  const ticket = state.list[state.progress.position];
  const correct = ticket.correct === index;

  markAnswerButtons(el("t-answers"), ticket.correct, index);

  const feedback = el("t-feedback");
  const correctText = ticket.answers[ticket.correct];
  feedback.textContent = correct ? `Верно: ${correctText}` : `Неверно. Правильный ответ: ${correctText}`;
  feedback.className = `exam__feedback ${correct ? "exam__feedback--ok" : "exam__feedback--bad"}`;

  state.progress = markAnswer(state.progress, ticket.id, correct);
  save();
  renderCounters();
  renderDashboard();
  if (state.topics.length) populateTopics(state.topics);
  if (typeof window.gtag === "function") {
    window.gtag("event", "training_answer", { correct, mode: state.filter });
  }
}

function finishSession() {
  state.completed = true;
  renderCard();
}

function go(delta) {
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
  renderCard({ focusQuestion: true });
}

function applySelection({ resetPosition = true, focusQuestion = false } = {}) {
  state.list = selectTrainingTickets(state.all, state.progress, selectionOptions());
  state.completed = false;
  state.progress = {
    ...state.progress,
    position: resetPosition ? 0 : clampPosition(state.progress.position, state.list.length),
  };
  renderFilterState();
  renderDashboard();
  save();
  renderCard({ focusQuestion });
}

function applyFilter(filter) {
  state.filter = filter;
  applySelection();
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
  const activeIds = new Set(state.all.filter((ticket) => ticket.lang === "ru" && !ticket.withdrawn).map((ticket) => ticket.id));
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

document.querySelectorAll(".exam__filter").forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;
    applyFilter(filter);
    if (typeof window.gtag === "function") {
      window.gtag("event", "training_mode_select", { mode: filter });
    }
  });
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
el("t-empty-action").addEventListener("click", () => {
  if (state.completed) {
    state.completed = false;
    state.progress = { ...state.progress, position: 0 };
    save();
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
  save();
  renderDashboard();
  if (state.topics.length) populateTopics(state.topics);
  applySelection();
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
    populateTopics(state.topics);
  } catch {
    state.topics = [];
    topicsUnavailable();
  }
}

(async function init() {
  const status = el("t-status");
  try {
    state.all = await loadTicketBank(DATA_URL);
    state.progress = readProgress(store());

    const requestedTicket = new URLSearchParams(window.location.search).get("ticket");
    if (requestedTicket && /^\d+$/.test(requestedTicket)) {
      state.filter = FILTERS.ALL;
      state.query = requestedTicket;
      el("t-search").value = requestedTicket;
    }

    status.hidden = true;
    renderDashboard();
    applySelection({ resetPosition: true, focusQuestion: false });
    loadTopics();
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
    topicsUnavailable();
  }
})();
