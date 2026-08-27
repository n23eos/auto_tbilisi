// Интерфейс тренировки. Правила и прогресс — в training-logic.js.

import {
  FILTERS,
  clampPosition,
  filterTickets,
  markAnswer,
  movePosition,
  readProgress,
  writeProgress,
} from "./training-logic.js";

const DATA_URL = "../../data/tickets-b-ru.json";
const IMAGES_BASE = "../../data/";

const el = (id) => document.getElementById(id);

const state = {
  all: [],
  list: [],
  progress: { solved: [], mistakes: [], position: 0 },
  filter: FILTERS.ALL,
  answered: false,
};

const EMPTY_TEXT = {
  [FILTERS.ALL]: "Билеты не загрузились.",
  [FILTERS.UNSOLVED]: "Нерешённых билетов не осталось — вы прошли все.",
  [FILTERS.MISTAKES]: "Ошибок пока нет. Они появятся здесь после экзамена или тренировки.",
};

function store() {
  // localStorage может быть запрещён — тогда работаем без запоминания.
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

function save() {
  writeProgress(store(), state.progress);
}

function renderCounters() {
  const ru = state.all.filter((t) => t.lang === "ru");
  const solved = state.progress.solved.length;
  el("t-total").textContent = String(state.list.length);
  el("t-index").textContent = String(state.list.length ? state.progress.position + 1 : 0);
  el("t-solved").textContent = String(solved);
  el("t-pool").textContent = String(ru.length);
  el("t-progress").style.width = ru.length ? `${(solved / ru.length) * 100}%` : "0";
}

function renderCard() {
  const ticket = state.list[state.progress.position];
  state.answered = false;

  el("t-empty").hidden = Boolean(ticket);
  el("t-card").hidden = !ticket;
  renderCounters();

  if (!ticket) {
    el("t-empty").textContent = EMPTY_TEXT[state.filter];
    return;
  }

  const question = el("t-text");
  question.textContent = ticket.question;

  const figure = el("t-figure");
  if (ticket.image) {
    el("t-image").src = IMAGES_BASE + ticket.image;
    figure.hidden = false;
  } else {
    el("t-image").removeAttribute("src");
    figure.hidden = true;
  }

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

  el("t-prev").disabled = state.progress.position === 0;
  el("t-next").disabled = state.progress.position >= state.list.length - 1;
  question.focus();
}

function answer(index) {
  if (state.answered) return;
  state.answered = true;

  const ticket = state.list[state.progress.position];
  const correct = ticket.correct === index;

  [...el("t-answers").querySelectorAll(".exam__answer")].forEach((button) => {
    button.disabled = true;
    const buttonIndex = Number(button.dataset.index);
    if (buttonIndex === ticket.correct) button.classList.add("exam__answer--correct");
    if (buttonIndex === index && !correct) button.classList.add("exam__answer--wrong");
  });

  const feedback = el("t-feedback");
  feedback.textContent = correct ? "Верно" : `Неверно. Правильный ответ — ${ticket.correct + 1}`;
  feedback.className = `exam__feedback ${correct ? "exam__feedback--ok" : "exam__feedback--bad"}`;

  state.progress = markAnswer(state.progress, ticket.id, correct);
  save();
  renderCounters();
}

function go(delta) {
  state.progress = {
    ...state.progress,
    position: movePosition(state.progress.position, delta, state.list.length),
  };
  save();
  renderCard();
}

function applyFilter(filter) {
  state.filter = filter;
  state.list = filterTickets(state.all, state.progress, filter);
  // Позиция запоминается только для полного списка: в отфильтрованных
  // наборах старый номер указывал бы на другой билет.
  state.progress = {
    ...state.progress,
    position: filter === FILTERS.ALL ? clampPosition(state.progress.position, state.list.length) : 0,
  };

  document.querySelectorAll(".exam__filter").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === filter);
  });

  save();
  renderCard();
}

document.querySelectorAll(".exam__filter").forEach((button) => {
  button.addEventListener("click", () => applyFilter(button.dataset.filter));
});

el("t-prev").addEventListener("click", () => go(-1));
el("t-next").addEventListener("click", () => go(1));

el("t-reset").addEventListener("click", () => {
  if (!window.confirm("Стереть весь прогресс тренировки? Отменить это будет нельзя.")) return;
  state.progress = { solved: [], mistakes: [], position: 0 };
  save();
  applyFilter(state.filter);
});

document.addEventListener("keydown", (event) => {
  if (el("t-card").hidden) return;
  if (event.key >= "1" && event.key <= "4") {
    const button = el("t-answers").querySelector(`[data-index="${Number(event.key) - 1}"]`);
    if (button && !button.disabled) button.click();
  }
  if (event.key === "ArrowRight") go(1);
  if (event.key === "ArrowLeft") go(-1);
});

(async function init() {
  const status = el("t-status");
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`код ${response.status}`);
    const data = await response.json();
    state.all = data.tickets;
    state.progress = readProgress(store());
    status.hidden = true;
    applyFilter(FILTERS.ALL);
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
  }
})();
