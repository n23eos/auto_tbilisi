// Интерфейс тренировки. Правила и прогресс — в training-logic.js.

import {
  FILTERS,
  clampPosition,
  filterTickets,
  markAnswer,
  movePosition,
  progressSummary,
  readProgress,
  writeProgress,
} from "./training-logic.js";
import { markAnswerButtons } from "./answer-marking.js";

const DATA_URL = "../../data/tickets-b-ru.json";
const IMAGES_BASE = "../../data/";

const el = (id) => document.getElementById(id);

const state = {
  all: [],
  list: [],
  progress: { solved: [], mistakes: [], position: 0, reviews: {} },
  filter: FILTERS.TODAY,
  answered: false,
};

const EMPTY_TEXT = {
  [FILTERS.TODAY]: "На сегодня всё готово. Возвращайтесь завтра или выберите другой режим.",
  [FILTERS.ALL]: "Билеты не загрузились.",
  [FILTERS.UNSOLVED]: "Нерешённых билетов не осталось — вы прошли все.",
  [FILTERS.MISTAKES]: "Ошибок пока нет. Они появятся здесь после экзамена или тренировки.",
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
  // Тот же отбор, что и в filterTickets: изъятые билеты ученику не показываются,
  // и в знаменателе прогресса их быть не должно — иначе шкала никогда не дойдёт до 100 %.
  const ru = state.all.filter((t) => t.lang === "ru" && !t.withdrawn);
  const solved = state.progress.solved.length;
  el("t-total").textContent = String(state.list.length);
  el("t-index").textContent = String(state.list.length ? state.progress.position + 1 : 0);
  el("t-solved").textContent = String(solved);
  el("t-pool").textContent = String(ru.length);
  el("t-progress").style.width = ru.length ? `${(solved / ru.length) * 100}%` : "0";
}

function renderDashboard() {
  const summary = progressSummary(state.all, state.progress);
  el("t-stat-solved").textContent = String(summary.solved);
  el("t-stat-due").textContent = String(summary.due);
  el("t-stat-remaining").textContent = String(summary.remaining);

  if (summary.due > 0) {
    el("t-plan-note").textContent = `Сначала повторите ${summary.due} ${ticketWord(summary.due)}, затем переходите к новым.`;
  } else if (summary.remaining > 0) {
    el("t-plan-note").textContent = "Повторений пока нет — начните с короткой подборки новых билетов.";
  } else {
    el("t-plan-note").textContent = "Все билеты решены, и срочных повторений нет. Можно пройти пробный экзамен.";
  }
  el("t-start-today").disabled = summary.due === 0 && summary.remaining === 0;
  el("t-dashboard").hidden = false;
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

  el("t-source-id").textContent = String(ticket.id);
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

  markAnswerButtons(el("t-answers"), ticket.correct, index);

  const feedback = el("t-feedback");
  const correctText = ticket.answers[ticket.correct];
  feedback.textContent = correct ? `Верно: ${correctText}` : `Неверно. Правильный ответ: ${correctText}`;
  feedback.className = `exam__feedback ${correct ? "exam__feedback--ok" : "exam__feedback--bad"}`;

  state.progress = markAnswer(state.progress, ticket.id, correct);
  save();
  renderCounters();
  renderDashboard();
  if (typeof window.gtag === "function") {
    window.gtag("event", "training_answer", { correct, mode: state.filter });
  }
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
    const isActive = button.dataset.filter === filter;
    button.classList.toggle("is-active", isActive);
    // Выбранный фильтр отличался только цветом фона — в дереве доступности
    // все три кнопки выглядели одинаково нажатыми.
    button.setAttribute("aria-pressed", String(isActive));
  });

  save();
  renderCard();
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

el("t-reset").addEventListener("click", () => {
  if (!window.confirm("Стереть весь прогресс тренировки? Отменить это будет нельзя.")) return;
  state.progress = { solved: [], mistakes: [], position: 0, reviews: {} };
  save();
  applyFilter(state.filter);
});

document.addEventListener("keydown", (event) => {
  if (el("t-card").hidden) return;
  if (event.key >= "1" && event.key <= "4") {
    const button = el("t-answers").querySelector(`[data-index="${Number(event.key) - 1}"]`);
    if (button && !button.disabled) button.click();
  }
  // preventDefault обязателен: без него стрелка и листает билет, и прокручивает
  // страницу — ученик уезжает к другому вопросу и вниз одновременно.
  if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
  if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
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
    renderDashboard();
    applyFilter(FILTERS.TODAY);
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
  }
})();
