// Интерфейс экзамена: DOM, таймер, обработчики.
// Вся логика правил — в exam-logic.js, здесь её только применяют.

import {
  MAX_MISTAKES,
  QUESTION_COUNT,
  TIME_LIMIT_SEC,
  createExamAnswers,
  examProgress,
  examVerdict,
  formatTime,
  isExamTerminal,
  isCorrect,
  nextUnansweredIndex,
  recordExamAnswer,
  selectExamTickets,
} from "./exam-logic.js?v=3";
import { markAnswer, readProgress, writeProgress } from "./training-logic.js?v=3";
import { markAnswerButtons } from "./answer-marking.js";
import { learningNextStep } from "./learning-next-step.js?v=1";
import { loadTicketBank } from "./ticket-bank.js?v=1";

const DATA_URL = "../data/tickets-b-ru.json?v=2";
const IMAGES_BASE = "../data/";
const URGENT_SEC = 60;
// Все картинки билетов одного размера — источник отдаёт 800×503.
const IMAGE_WIDTH = 800;
const IMAGE_HEIGHT = 503;

const el = (id) => document.getElementById(id);

const screens = {
  intro: el("screen-intro"),
  quiz: el("screen-quiz"),
  result: el("screen-result"),
};

const state = {
  pool: [],
  questions: [],
  answers: [],
  index: 0,
  mistakes: 0,
  answered: 0,
  wrong: [],
  startedAt: 0,
  timerId: null,
  finishTimerId: null,
  finished: false,
  locked: false,
};

function show(name) {
  Object.entries(screens).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

async function loadTickets() {
  return loadTicketBank(DATA_URL);
}

function preloadImage(ticket) {
  if (!ticket || !ticket.image) return;
  const img = new Image();
  img.src = IMAGES_BASE + ticket.image;
}

function renderNavigation() {
  const navigation = el("q-navigation");
  navigation.textContent = "";

  state.answers.forEach((answerState, questionIndex) => {
    const button = document.createElement("button");
    const current = questionIndex === state.index;
    const answered = answerState !== null;
    button.type = "button";
    button.className = `exam__filter${current ? " is-active" : ""}`;
    button.textContent = answered ? `${questionIndex + 1} ✓` : String(questionIndex + 1);
    button.setAttribute(
      "aria-label",
      `Вопрос ${questionIndex + 1}, ${answered ? "отвечен" : "без ответа"}${current ? ", текущий" : ""}`
    );
    if (current) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => goToQuestion(questionIndex));
    navigation.append(button);
  });
}

function renderQuestion() {
  const ticket = state.questions[state.index];
  const answerState = state.answers[state.index];
  state.locked = answerState !== null;

  el("q-index").textContent = String(state.index + 1);
  el("q-total").textContent = String(QUESTION_COUNT);
  el("q-mistakes").textContent = String(state.mistakes);
  el("q-progress").style.width = `${(state.answered / QUESTION_COUNT) * 100}%`;

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
  el("btn-next").hidden = answerState === null;
  el("btn-skip").hidden = answerState !== null;

  if (answerState !== null) {
    markAnswerButtons(el("q-answers"), ticket.correct, answerState.chosen);
    if (answerState.correct) {
      feedback.textContent = "Верно";
      feedback.className = "exam__feedback exam__feedback--ok";
    } else {
      feedback.textContent = `Неверно. Правильный ответ - ${ticket.correct + 1}`;
      feedback.className = "exam__feedback exam__feedback--bad";
    }
  }

  renderNavigation();
  question.focus();
  const preloadIndex = nextUnansweredIndex(state.answers, state.index);
  preloadImage(preloadIndex >= 0 ? state.questions[preloadIndex] : null);
}

function answer(answerIndex) {
  if (state.locked || state.finished || isExamTerminal(state)) return;

  const ticket = state.questions[state.index];
  const correct = isCorrect(ticket, answerIndex);
  const result = recordExamAnswer(state.answers, state.index, answerIndex, ticket.correct);
  if (!result.recorded) return;

  state.answers = result.answers;
  state.locked = true;
  const progress = examProgress(state.answers);
  state.answered = progress.answered;
  state.mistakes = progress.mistakes;
  markAnswerButtons(el("q-answers"), ticket.correct, answerIndex);

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
    state.wrong.push({ ticket, chosen: answerIndex });
    feedback.textContent = `Неверно. Правильный ответ - ${ticket.correct + 1}`;
    feedback.className = "exam__feedback exam__feedback--bad";
  }
  el("q-mistakes").textContent = String(state.mistakes);
  el("q-progress").style.width = `${(state.answered / QUESTION_COUNT) * 100}%`;
  renderNavigation();

  if (isExamTerminal(state)) {
    state.finishTimerId = window.setTimeout(() => finish(false), 900);
    return;
  }
  el("btn-next").hidden = false;
  el("btn-skip").hidden = true;
  el("btn-next").focus();
}

function goToQuestion(questionIndex) {
  if (
    screens.quiz.hidden ||
    state.finished ||
    isExamTerminal(state) ||
    questionIndex < 0 ||
    questionIndex >= state.questions.length
  ) return;

  state.index = questionIndex;
  renderQuestion();
}

function next() {
  if (screens.quiz.hidden || state.answers[state.index] === null || isExamTerminal(state)) return;
  const questionIndex = nextUnansweredIndex(state.answers, state.index);
  if (questionIndex < 0) {
    finish(false);
    return;
  }
  goToQuestion(questionIndex);
}

function skip() {
  if (screens.quiz.hidden || state.answers[state.index] !== null || isExamTerminal(state)) return;
  const questionIndex = nextUnansweredIndex(state.answers, state.index);
  if (questionIndex === state.index) {
    el("q-feedback").textContent = "Других вопросов без ответа нет.";
    return;
  }
  goToQuestion(questionIndex);
}

function tick() {
  const left = TIME_LIMIT_SEC - Math.floor((Date.now() - state.startedAt) / 1000);
  const timer = el("q-timer");
  timer.textContent = formatTime(left);
  const urgent = left <= URGENT_SEC;
  timer.classList.toggle("exam__timer--urgent", urgent);
  // Красный цвет — единственное предупреждение, которое было. Один раз
  // произносим его вслух: сплошная живая область на каждую секунду сделала бы
  // страницу непригодной для скринридера.
  if (urgent && !state.urgentAnnounced) {
    state.urgentAnnounced = true;
    el("q-feedback").textContent = "Осталась минута.";
  }
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
      // Размеры до загрузки: без них каждая картинка разбора, доехав,
      // сдвигает вниз всё, что под ней, — а разбор читают прокручивая.
      img.width = IMAGE_WIDTH;
      img.height = IMAGE_HEIGHT;
      img.decoding = "async";
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
  // Таймер и задержка после последнего ответа могут сработать вместе.
  // Итог и событие конверсии должны появиться только один раз.
  if (state.finished) return;
  state.finished = true;
  window.clearTimeout(state.finishTimerId);
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
  const recommendation = learningNextStep(verdict);
  el('r-next-title').textContent = recommendation.title;
  el('r-next-text').textContent = recommendation.text;
  const nextLink = el('r-next-link');
  nextLink.textContent = recommendation.label;
  nextLink.href = `../?from=exam&goal=${recommendation.goal}#callback-form`;
  nextLink.dataset.learningCta = recommendation.goal;
  if (typeof window.gtag === 'function') {
    window.gtag('event', 'exam_complete', {
      result: verdict.passed ? 'pass' : 'fail', reason: verdict.reason,
      answered: state.answered, mistakes: state.mistakes,
    });
  }
  show("result");
  // show() прячет экран вопроса, а фокус в этот момент стоит на кнопке внутри
  // него — браузер сбрасывает его в начало страницы, и о конце экзамена
  // незрячий ученик не узнаёт вовсе. Особенно важно, когда экзамен оборвал
  // таймер: человек этого не выбирал.
  const verdictEl = el("r-verdict");
  verdictEl.focus();
  title.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

function start() {
  window.clearTimeout(state.finishTimerId);
  state.finished = false;
  if (typeof window.gtag === 'function') window.gtag('event', 'exam_start');
  // Порог берём из логики, а не из разметки: иначе при его изменении
  // текст на странице и поведение экзамена разъедутся.
  el("q-max").textContent = String(MAX_MISTAKES);
  el("rule-max").textContent = String(MAX_MISTAKES);

  state.questions = selectExamTickets(state.pool);
  state.answers = createExamAnswers(state.questions.length);
  state.index = 0;
  state.mistakes = 0;
  state.answered = 0;
  state.wrong = [];
  state.startedAt = Date.now();
  state.urgentAnnounced = false;

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
  const interactive = event.target.closest?.("button, a, input, select, textarea");
  if ((event.key === "Enter" || event.key === " ") && !interactive && !el("btn-next").hidden) {
    event.preventDefault();
    next();
  }
});

el("btn-next").addEventListener("click", next);
el("btn-skip").addEventListener("click", skip);
el("btn-start").addEventListener("click", start);
el("btn-restart").addEventListener("click", start);

(async function init() {
  const startButton = el("btn-start");
  const status = el("intro-status");
  startButton.disabled = true;
  try {
    state.pool = await loadTickets();
    // Счётчик использует тот же языковой отбор, что и экзамен.
    const ready = state.pool.filter((t) => t.lang === "ru").length;
    const word = ready % 100 >= 11 && ready % 100 <= 14
      ? "вопросов"
      : ready % 10 === 1 ? "вопрос" : ready % 10 >= 2 && ready % 10 <= 4 ? "вопроса" : "вопросов";
    status.textContent = `Готово: ${ready} ${word} на русском`;
    startButton.disabled = false;
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
  }
})();
