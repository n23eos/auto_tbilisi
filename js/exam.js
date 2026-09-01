// Интерфейс экзамена: DOM, таймер, обработчики.
// Вся логика правил — в exam-logic.js, здесь её только применяют.

import {
  MAX_MISTAKES,
  QUESTION_COUNT,
  TIME_LIMIT_SEC,
  examVerdict,
  formatTime,
  isCorrect,
  selectExamTickets,
} from "./exam-logic.js";
import { markAnswer, readProgress, writeProgress } from "./training-logic.js";

const DATA_URL = "../data/tickets-b-ru.json";
const IMAGES_BASE = "../data/";
const URGENT_SEC = 60;

const el = (id) => document.getElementById(id);

const screens = {
  intro: el("screen-intro"),
  quiz: el("screen-quiz"),
  result: el("screen-result"),
};

const state = {
  pool: [],
  questions: [],
  index: 0,
  mistakes: 0,
  answered: 0,
  wrong: [],
  startedAt: 0,
  timerId: null,
  locked: false,
};

function show(name) {
  Object.entries(screens).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

async function loadTickets() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`не удалось загрузить билеты (${response.status})`);
  }
  const data = await response.json();
  return data.tickets;
}

function preloadImage(ticket) {
  if (!ticket || !ticket.image) return;
  const img = new Image();
  img.src = IMAGES_BASE + ticket.image;
}

function renderQuestion() {
  const ticket = state.questions[state.index];
  state.locked = false;

  el("q-index").textContent = String(state.index + 1);
  el("q-total").textContent = String(QUESTION_COUNT);
  el("q-mistakes").textContent = String(state.mistakes);
  el("q-progress").style.width = `${(state.index / QUESTION_COUNT) * 100}%`;

  const question = el("q-text");
  question.textContent = ticket.question;

  const figure = el("q-figure");
  if (ticket.image) {
    el("q-image").src = IMAGES_BASE + ticket.image;
    figure.hidden = false;
  } else {
    el("q-image").removeAttribute("src");
    figure.hidden = true;
  }

  const list = el("q-answers");
  list.textContent = "";
  ticket.answers.forEach((text, answerIndex) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "exam__answer";
    button.dataset.index = String(answerIndex);

    const num = document.createElement("span");
    num.className = "exam__answer-num";
    num.textContent = `${answerIndex + 1}`;

    const label = document.createElement("span");
    label.textContent = text;

    button.append(num, label);
    button.addEventListener("click", () => answer(answerIndex));
    item.append(button);
    list.append(item);
  });

  const feedback = el("q-feedback");
  feedback.textContent = "";
  feedback.className = "exam__feedback";
  el("btn-next").hidden = true;

  question.focus();
  preloadImage(state.questions[state.index + 1]);
}

function answer(answerIndex) {
  if (state.locked) return;
  state.locked = true;
  state.answered += 1;

  const ticket = state.questions[state.index];
  const correct = isCorrect(ticket, answerIndex);
  const buttons = [...el("q-answers").querySelectorAll(".exam__answer")];

  buttons.forEach((button) => {
    button.disabled = true;
    const index = Number(button.dataset.index);
    if (index === ticket.correct) button.classList.add("exam__answer--correct");
    if (index === answerIndex && !correct) button.classList.add("exam__answer--wrong");
  });

  // Ошибки экзамена попадают в общий прогресс, чтобы их можно было
  // отработать в разделе тренировки.
  try {
    const storage = window.localStorage;
    writeProgress(storage, markAnswer(readProgress(storage), ticket.id, correct));
  } catch {
    // Хранилище недоступно — экзамену это не мешает.
  }

  const feedback = el("q-feedback");
  if (correct) {
    feedback.textContent = "Верно";
    feedback.className = "exam__feedback exam__feedback--ok";
  } else {
    state.mistakes += 1;
    state.wrong.push({ ticket, chosen: answerIndex });
    feedback.textContent = `Неверно. Правильный ответ — ${ticket.correct + 1}`;
    feedback.className = "exam__feedback exam__feedback--bad";
  }
  el("q-mistakes").textContent = String(state.mistakes);

  if (state.mistakes > MAX_MISTAKES || state.index + 1 >= QUESTION_COUNT) {
    window.setTimeout(() => finish(false), 900);
    return;
  }
  el("btn-next").hidden = false;
  el("btn-next").focus();
}

function next() {
  if (state.index + 1 >= QUESTION_COUNT) {
    finish(false);
    return;
  }
  state.index += 1;
  renderQuestion();
}

function tick() {
  const left = TIME_LIMIT_SEC - Math.floor((Date.now() - state.startedAt) / 1000);
  const timer = el("q-timer");
  timer.textContent = formatTime(left);
  timer.classList.toggle("exam__timer--urgent", left <= URGENT_SEC);
  if (left <= 0) finish(true);
}

function renderReview() {
  const list = el("r-review");
  list.textContent = "";
  el("r-mistakes-title").hidden = state.wrong.length === 0;

  state.wrong.forEach(({ ticket, chosen }) => {
    const item = document.createElement("li");
    item.className = "exam__review-item";

    const question = document.createElement("p");
    question.className = "exam__review-q";
    question.textContent = ticket.question;
    item.append(question);

    if (ticket.image) {
      const img = document.createElement("img");
      img.className = "exam__review-img";
      img.loading = "lazy";
      img.src = IMAGES_BASE + ticket.image;
      img.alt = "Изображение к вопросу билета";
      item.append(img);
    }

    const wrong = document.createElement("p");
    wrong.className = "exam__review-line exam__review-line--wrong";
    wrong.innerHTML = "Вы выбрали: ";
    wrong.append(document.createTextNode(ticket.answers[chosen]));
    item.append(wrong);

    const right = document.createElement("p");
    right.className = "exam__review-line exam__review-line--right";
    right.innerHTML = "Правильно: ";
    right.append(document.createTextNode(ticket.answers[ticket.correct]));
    item.append(right);

    list.append(item);
  });
}

function finish(timeUp) {
  window.clearInterval(state.timerId);
  const verdict = examVerdict({
    answered: state.answered,
    mistakes: state.mistakes,
    timeUp,
  });

  const spent = Math.min(
    TIME_LIMIT_SEC,
    Math.floor((Date.now() - state.startedAt) / 1000)
  );

  const title = el("r-verdict");
  title.textContent = verdict.passed ? "Экзамен сдан" : "Экзамен не сдан";
  title.className = `exam__verdict ${verdict.passed ? "exam__verdict--pass" : "exam__verdict--fail"}`;

  const reasons = {
    mistakes: `Ошибок ${state.mistakes} при допустимых ${MAX_MISTAKES} — экзамен остановлен.`,
    time: "Время вышло раньше, чем закончились вопросы.",
    unfinished: "Экзамен не завершён.",
    completed: `Ошибок ${state.mistakes} из ${MAX_MISTAKES} допустимых.`,
  };

  el("r-summary").textContent =
    `${reasons[verdict.reason]} Отвечено ${state.answered} из ${QUESTION_COUNT}, время — ${formatTime(spent)}.`;

  renderReview();
  show("result");
  title.scrollIntoView({ behavior: "smooth", block: "start" });
}

function start() {
  // Порог берём из логики, а не из разметки: иначе при его изменении
  // текст на странице и поведение экзамена разъедутся.
  el("q-max").textContent = String(MAX_MISTAKES);
  el("rule-max").textContent = String(MAX_MISTAKES);

  state.questions = selectExamTickets(state.pool);
  state.index = 0;
  state.mistakes = 0;
  state.answered = 0;
  state.wrong = [];
  state.startedAt = Date.now();

  el("q-timer").textContent = formatTime(TIME_LIMIT_SEC);
  window.clearInterval(state.timerId);
  state.timerId = window.setInterval(tick, 1000);

  show("quiz");
  renderQuestion();
}

document.addEventListener("keydown", (event) => {
  if (screens.quiz.hidden) return;
  if (event.key >= "1" && event.key <= "4") {
    const button = el("q-answers").querySelector(`[data-index="${Number(event.key) - 1}"]`);
    if (button && !button.disabled) button.click();
  }
  if ((event.key === "Enter" || event.key === " ") && !el("btn-next").hidden) {
    event.preventDefault();
    next();
  }
});

el("btn-next").addEventListener("click", next);
el("btn-start").addEventListener("click", start);
el("btn-restart").addEventListener("click", start);

(async function init() {
  const startButton = el("btn-start");
  const status = el("intro-status");
  startButton.disabled = true;
  try {
    state.pool = await loadTickets();
    // Тот же отбор, что и в selectExamTickets: изъятые билеты в экзамен не попадают,
    // поэтому и в счётчике их быть не должно — иначе обещаем больше, чем показываем.
    const ready = state.pool.filter((t) => t.lang === "ru" && !t.withdrawn).length;
    status.textContent = `Готово: ${ready} билетов на русском`;
    startButton.disabled = false;
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
  }
})();
