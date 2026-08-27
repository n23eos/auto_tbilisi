# Свободная тренировка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development или superpowers:executing-plans.

**Goal:** Страница `/bilety/trenirovka/` с прогоном всех билетов и работой над ошибками, с запоминанием прогресса в браузере.

**Architecture:** Чистая логика прогресса и фильтров в `js/training-logic.js` (тесты через `node --test`), DOM в `js/training.js`. Хранилище — `localStorage`, доступ к нему всегда через try/catch. Экзамен пишет свои ошибки в то же хранилище.

**Spec:** `docs/superpowers/specs/2026-08-27-training-mode-design.md`

---

### Task 1: Логика прогресса и фильтров

**Files:** Create `js/training-logic.js`, `js/tests/training-logic.test.js`

- [ ] **Step 1: Тесты**

`js/tests/training-logic.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  FILTERS,
  STORAGE_KEY,
  clampPosition,
  filterTickets,
  markAnswer,
  movePosition,
  readProgress,
  writeProgress,
} from "../training-logic.js";

function fakeStorage(initial = null, { throwOnGet = false, throwOnSet = false } = {}) {
  let value = initial;
  return {
    getItem() {
      if (throwOnGet) throw new Error("хранилище недоступно");
      return value;
    },
    setItem(_key, next) {
      if (throwOnSet) throw new Error("хранилище недоступно");
      value = next;
    },
    read: () => value,
  };
}

const tickets = [
  { id: 1, lang: "ru" },
  { id: 2, lang: "ru" },
  { id: 3, lang: "ru" },
  { id: 9, lang: "ka" },
];

test("пустое хранилище даёт пустой прогресс", () => {
  const progress = readProgress(fakeStorage());
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("битый JSON не роняет тренажёр", () => {
  const progress = readProgress(fakeStorage("{не json"));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("хранилище с мусором вместо массивов даёт пустой прогресс", () => {
  const progress = readProgress(fakeStorage('{"solved":"всё","mistakes":7,"position":"да"}'));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("недоступное хранилище не роняет чтение", () => {
  const progress = readProgress(fakeStorage(null, { throwOnGet: true }));
  assert.deepEqual(progress, { solved: [], mistakes: [], position: 0 });
});

test("недоступное хранилище не роняет запись", () => {
  const ok = writeProgress(fakeStorage(null, { throwOnSet: true }), { solved: [], mistakes: [], position: 0 });
  assert.equal(ok, false);
});

test("запись и чтение возвращают тот же прогресс", () => {
  const storage = fakeStorage();
  writeProgress(storage, { solved: [2], mistakes: [3], position: 5 });
  assert.deepEqual(readProgress(storage), { solved: [2], mistakes: [3], position: 5 });
  assert.ok(storage.read().includes(STORAGE_KEY) === false); // ключ не в значении
});

test("верный ответ добавляет билет в решённые", () => {
  const next = markAnswer({ solved: [], mistakes: [], position: 0 }, 5, true);
  assert.deepEqual(next.solved, [5]);
  assert.deepEqual(next.mistakes, []);
});

test("неверный ответ добавляет билет в ошибки и не в решённые", () => {
  const next = markAnswer({ solved: [], mistakes: [], position: 0 }, 5, false);
  assert.deepEqual(next.mistakes, [5]);
  assert.deepEqual(next.solved, []);
});

test("исправленная ошибка уходит из списка ошибок", () => {
  const after = markAnswer(markAnswer({ solved: [], mistakes: [], position: 0 }, 5, false), 5, true);
  assert.deepEqual(after.mistakes, []);
  assert.deepEqual(after.solved, [5]);
});

test("ошибка в ранее решённом билете убирает его из решённых", () => {
  const after = markAnswer({ solved: [5], mistakes: [], position: 0 }, 5, false);
  assert.deepEqual(after.solved, []);
  assert.deepEqual(after.mistakes, [5]);
});

test("markAnswer не мутирует переданный прогресс", () => {
  const before = { solved: [], mistakes: [], position: 0 };
  markAnswer(before, 5, true);
  assert.deepEqual(before, { solved: [], mistakes: [], position: 0 });
});

test("фильтр «все» отдаёт только русские билеты", () => {
  const list = filterTickets(tickets, { solved: [], mistakes: [], position: 0 }, FILTERS.ALL);
  assert.deepEqual(list.map((t) => t.id), [1, 2, 3]);
});

test("фильтр «нерешённые» исключает решённые", () => {
  const list = filterTickets(tickets, { solved: [2], mistakes: [], position: 0 }, FILTERS.UNSOLVED);
  assert.deepEqual(list.map((t) => t.id), [1, 3]);
});

test("фильтр «мои ошибки» отдаёт только ошибочные", () => {
  const list = filterTickets(tickets, { solved: [], mistakes: [3], position: 0 }, FILTERS.MISTAKES);
  assert.deepEqual(list.map((t) => t.id), [3]);
});

test("грузинские билеты не попадают ни в один фильтр", () => {
  for (const filter of Object.values(FILTERS)) {
    const list = filterTickets(tickets, { solved: [9], mistakes: [9], position: 0 }, filter);
    assert.ok(list.every((t) => t.lang === "ru"));
  }
});

test("позиция не уходит за границы списка", () => {
  assert.equal(clampPosition(99, 3), 2);
  assert.equal(clampPosition(-4, 3), 0);
  assert.equal(clampPosition(1, 0), 0);
  assert.equal(clampPosition("нет", 3), 0);
});

test("переход вперёд с последнего билета остаётся на последнем", () => {
  assert.equal(movePosition(2, 1, 3), 2);
});

test("переход назад с первого билета остаётся на первом", () => {
  assert.equal(movePosition(0, -1, 3), 0);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
npm test
```

- [ ] **Step 3: Реализация**

`js/training-logic.js`:
```js
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
```

- [ ] **Step 4: Тесты зелёные**

```bash
npm test
```
Ожидаемо: 10 прежних + 18 новых.

- [ ] **Step 5: Самопроверка мутациями**

1. в `markAnswer` заменить `{ ...progress, solved: ... }` на изменение `progress.solved` на месте → падает тест про мутацию;
2. в `readProgress` убрать `try/catch` → падают тесты про битый JSON и недоступное хранилище.

- [ ] **Step 6: Commit**

```bash
git add js/training-logic.js js/tests/training-logic.test.js
git commit -m "feat: логика тренировки — прогресс, фильтры, навигация"
```

---

### Task 2: Страница тренировки

**Files:** Create `bilety/trenirovka/index.html`, Modify `css/exam.css`

- [ ] **Step 1: Разметка**

За основу берётся `bilety/index.html`: та же шапка `<header class="nav is-solid">`, тот же подвал, те же классы `exam__*`. Пути к ресурсам — на два уровня вверх (`../../`).

Тело:
```html
  <main class="exam" id="training">
    <h1 class="exam__title">Тренировка по билетам ПДД</h1>
    <p class="exam__lead">
      Все билеты по порядку, без таймера и лимита ошибок. Браузер запомнит,
      где вы остановились и что уже решено.
    </p>

    <div class="exam__filters" role="group" aria-label="Что показывать">
      <button class="exam__filter is-active" id="filter-all" type="button" data-filter="all">Все билеты</button>
      <button class="exam__filter" id="filter-unsolved" type="button" data-filter="unsolved">Нерешённые</button>
      <button class="exam__filter" id="filter-mistakes" type="button" data-filter="mistakes">Мои ошибки</button>
    </div>

    <div class="exam__bar">
      <span class="exam__counter">Билет <b id="t-index">1</b> из <b id="t-total">0</b></span>
      <span class="exam__counter">Решено верно: <b id="t-solved">0</b> из <b id="t-pool">0</b></span>
    </div>
    <div class="exam__progress"><div class="exam__progress-fill" id="t-progress"></div></div>

    <p class="exam__status" id="t-status" role="status">Загружаем билеты…</p>

    <section class="exam__screen" id="t-card" hidden>
      <h2 class="exam__question" id="t-text" tabindex="-1"></h2>
      <figure class="exam__figure" id="t-figure" hidden>
        <img class="exam__image" id="t-image" src="" alt="Изображение к вопросу билета">
      </figure>
      <ul class="exam__answers" id="t-answers"></ul>
      <p class="exam__feedback" id="t-feedback" role="status" aria-live="polite"></p>
      <div class="exam__actions">
        <button class="exam__btn exam__btn--ghost" id="t-prev" type="button">← Назад</button>
        <button class="exam__btn exam__btn--primary" id="t-next" type="button">Дальше →</button>
      </div>
      <p class="exam__hint">Ответ — клавиши 1–4, переход — стрелки влево и вправо</p>
    </section>

    <p class="exam__empty" id="t-empty" hidden></p>

    <div class="exam__reset">
      <button class="exam__btn exam__btn--ghost" id="t-reset" type="button">Сбросить прогресс</button>
      <p class="exam__note">
        Прогресс хранится только в этом браузере: на другом устройстве его не будет,
        а в приватном окне он не сохранится. Кнопка сброса стирает его безвозвратно.
      </p>
    </div>

    <p class="exam__source">
      Вопросы и изображения — официальные экзаменационные билеты Грузии, источник:
      <a href="https://teoria.on.ge" rel="nofollow noopener" target="_blank">teoria.on.ge</a>.
      Тема «эко-вождение» (51 билет) есть только на грузинском и в тренировку не включена.
    </p>
  </main>

  <script type="module" src="../../js/training.js?v=1"></script>
```
Заголовок страницы: `Тренировка по билетам ПДД Грузии на русском — все 870 вопросов`, canonical `https://avtoshkola.ge/bilety/trenirovka/`.

- [ ] **Step 2: Стили — дописать в конец `css/exam.css`**

```css
/* --- Тренировка --- */

.exam__filters { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-bottom: var(--space-lg); }

.exam__filter {
  border: var(--rule-hair);
  border-radius: var(--radius-sm);
  background: var(--color-paper-2);
  color: var(--color-ink-muted);
  padding: var(--space-2xs) var(--space-md);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
}

.exam__filter:hover { border-color: var(--color-line-strong); }
.exam__filter:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }

.exam__filter.is-active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
}

.exam__empty { font-size: var(--text-lg); color: var(--color-ink-muted); margin: var(--space-2xl) 0; }
.exam__reset { margin-top: var(--space-3xl); }
.exam__note { font-size: var(--text-xs); color: var(--color-ink-faint); max-width: 34rem; margin-top: var(--space-xs); }
```

- [ ] **Step 3: Commit**

```bash
git add bilety/trenirovka/index.html css/exam.css
git commit -m "feat: страница тренировки — разметка и стили"
```

---

### Task 3: Интерфейс тренировки

**Files:** Create `js/training.js`

- [ ] **Step 1: Написать**

```js
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
```

- [ ] **Step 2: Тесты логики по-прежнему зелёные**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add js/training.js
git commit -m "feat: интерфейс тренировки — фильтры, навигация, прогресс"
```

---

### Task 4: Экзамен пишет ошибки в общее хранилище

**Files:** Modify `js/exam.js`

Смысл: провалил экзамен — ошибочные билеты сразу оказались в «работе над ошибками».

- [ ] **Step 1: Правка**

В `js/exam.js` добавить импорт:
```js
import { markAnswer, readProgress, writeProgress } from "./training-logic.js";
```

И в функции `answer`, сразу после подсчёта `correct`, записать результат:
```js
  // Ошибки экзамена попадают в общий прогресс, чтобы их можно было
  // отработать в разделе тренировки.
  try {
    const storage = window.localStorage;
    writeProgress(storage, markAnswer(readProgress(storage), ticket.id, correct));
  } catch {
    // Хранилище недоступно — экзамену это не мешает.
  }
```

- [ ] **Step 2: Проверить, что тесты зелёные**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add js/exam.js
git commit -m "feat: ошибки экзамена попадают в работу над ошибками"
```

---

### Task 5: Ссылки

**Files:** Modify `bilety/index.html`, `index.html`, `sitemap.xml`, `llms.txt`

- [ ] **Step 1: С экрана старта экзамена — ссылка на тренировку**

В `bilety/index.html` под кнопкой «Начать экзамен»:
```html
      <p class="exam__hint">
        Хотите сначала разобраться без таймера — <a href="trenirovka/">свободная тренировка по всем билетам</a>.
      </p>
```

- [ ] **Step 2: На странице тренировки — ссылка на экзамен**

В `bilety/trenirovka/index.html` под фильтрами:
```html
      <p class="exam__hint">Готовы проверить себя — <a href="../">пройти экзамен</a>.</p>
```

- [ ] **Step 3: sitemap.xml**

Добавить запись по образцу существующей, `lastmod` 2026-08-27:
```xml
  <url>
    <loc>https://avtoshkola.ge/bilety/trenirovka/</loc>
    <lastmod>2026-08-27</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
```

- [ ] **Step 4: llms.txt**

```
- [Тренировка по билетам ПДД](https://avtoshkola.ge/bilety/trenirovka/): все 870 билетов на русском без таймера, с запоминанием прогресса и работой над ошибками.
```

- [ ] **Step 5: Проверить XML и commit**

```bash
.venv/bin/python -c "import xml.dom.minidom; xml.dom.minidom.parse('sitemap.xml'); print('xml ok')"
git add bilety/index.html bilety/trenirovka/index.html sitemap.xml llms.txt
git commit -m "feat: перекрёстные ссылки экзамена и тренировки, sitemap, llms.txt"
```

---

### Task 6: Проверка в браузере

- [ ] **Step 1** Открыть `/bilety/trenirovka/`, убедиться: счётчики заполнены, первый билет показан.
- [ ] **Step 2** Ответить верно → зелёная подсветка, «Решено верно» выросло на 1.
- [ ] **Step 3** Ответить неверно → красная подсветка, правильный подсвечен зелёным.
- [ ] **Step 4** Перезагрузить страницу → счётчик решённых сохранился, позиция та же.
- [ ] **Step 5** Фильтр «Мои ошибки» → показывает только те билеты, где была ошибка.
- [ ] **Step 6** Решить ошибочный билет верно, снова открыть «Мои ошибки» → билет ушёл из списка.
- [ ] **Step 7** Фильтр «Нерешённые» → решённые билеты отсутствуют.
- [ ] **Step 8** Стрелки влево-вправо и клавиши 1–4 работают.
- [ ] **Step 9** Сброс прогресса спрашивает подтверждение и обнуляет счётчики.
- [ ] **Step 10** Пройти экзамен с ошибками → эти билеты появились в «Моих ошибках» на странице тренировки.
- [ ] **Step 11** Мобильный вид 375px.
- [ ] **Step 12** Консоль без ошибок.

---

## Итог

`/bilety/` — экзамен, `/bilety/trenirovka/` — подготовка. Ошибки экзамена перетекают
в работу над ошибками. Прогресс живёт в браузере ученика, логика покрыта тестами без браузера.
