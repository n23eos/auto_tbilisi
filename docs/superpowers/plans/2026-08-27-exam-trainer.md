# Тренажёр «Экзамен ПДД» + WebP — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница `/bilety/` с экзаменом по правилам настоящего (30 вопросов, 30 минут, до 3 ошибок) и перевод картинок билетов в WebP (66 МБ → ~21 МБ).

**Architecture:** Логика экзамена — чистые функции без DOM в `js/exam-logic.js`, проверяются встроенным `node --test`. Работа с DOM и таймером — отдельно в `js/exam.js`. Картинки: парсер держит скачанные JPEG в кэше (вне git), а в репозиторий кладёт только WebP.

**Tech Stack:** Ванильный HTML/CSS/JS без сборщиков (как весь сайт), Python + Pillow для конвертации, node --test для тестов логики.

**Spec:** `docs/superpowers/specs/2026-08-27-exam-trainer-design.md`

**Ветка:** `dev`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `tools/parse_tickets.py` | + константы WebP и `convert_to_webp`, `collect` кладёт в репо только `.webp` |
| `package.json` | `type: module` и `npm test` — чтобы `node --test` понимал ESM |
| `js/exam-logic.js` | Чистая логика: выборка, проверка ответа, вердикт, формат времени |
| `js/exam.js` | DOM, таймер, обработчики, загрузка JSON |
| `js/tests/exam-logic.test.js` | Тесты логики |
| `bilety/index.html` | Страница экзамена |
| `css/exam.css` | Стили страницы |
| `index.html`, `sitemap.xml`, `llms.txt` | Ссылки на новый раздел |

---

### Task 1: Конвертация картинок в WebP

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
def test_convert_to_webp_creates_decodable_file(tmp_path):
    src = tmp_path / "src.jpg"
    Image.new("RGB", (400, 300), (120, 30, 200)).save(src, format="JPEG")
    dest = tmp_path / "out.webp"
    assert pt.convert_to_webp(src, dest) is True
    assert dest.exists()
    with Image.open(dest) as image:
        assert image.format == "WEBP"


def test_convert_to_webp_shrinks_wide_image(tmp_path):
    src = tmp_path / "wide.jpg"
    Image.new("RGB", (1006, 632), (10, 10, 10)).save(src, format="JPEG")
    dest = tmp_path / "wide.webp"
    assert pt.convert_to_webp(src, dest) is True
    with Image.open(dest) as image:
        assert image.width == pt.WEBP_MAX_WIDTH
        # Пропорции сохраняются: 1006x632 -> 800x503.
        assert image.height == round(632 * pt.WEBP_MAX_WIDTH / 1006)


def test_convert_to_webp_keeps_small_image_size(tmp_path):
    src = tmp_path / "small.jpg"
    Image.new("RGB", (320, 200), (10, 10, 10)).save(src, format="JPEG")
    dest = tmp_path / "small.webp"
    assert pt.convert_to_webp(src, dest) is True
    with Image.open(dest) as image:
        assert image.size == (320, 200)


def test_convert_to_webp_rejects_corrupt_source(tmp_path):
    src = tmp_path / "broken.jpg"
    src.write_text("<html>это не картинка</html>", encoding="utf-8")
    dest = tmp_path / "broken.webp"
    assert pt.convert_to_webp(src, dest) is False
    assert not dest.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_convert_to_webp_skips_existing_valid_file(tmp_path, monkeypatch):
    src = tmp_path / "src.jpg"
    Image.new("RGB", (400, 300), (0, 200, 0)).save(src, format="JPEG")
    dest = tmp_path / "out.webp"
    assert pt.convert_to_webp(src, dest) is True

    def fail_open(*args, **kwargs):
        raise AssertionError("повторная конвертация не нужна")

    monkeypatch.setattr(pt.Image, "open", fail_open)
    assert pt.convert_to_webp(src, dest) is True


def test_convert_to_webp_cleans_up_tmp_on_failure(tmp_path, monkeypatch):
    src = tmp_path / "src.jpg"
    Image.new("RGB", (400, 300), (0, 0, 200)).save(src, format="JPEG")
    dest = tmp_path / "out.webp"

    def boom(src_path, dst_path):
        raise OSError("диск кончился")

    monkeypatch.setattr(pt.os, "replace", boom)
    assert pt.convert_to_webp(src, dest) is False
    assert not list(tmp_path.glob("*.tmp"))
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k convert_to_webp -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'convert_to_webp'`

- [ ] **Step 3: Написать реализацию**

Добавить константы рядом с остальными путями в `tools/parse_tickets.py`:
```python
# Скачанные JPEG живут в кэше и в git не попадают: в репозитории лежит только WebP.
CACHE_IMAGES_DIR = TOOLS_DIR / ".cache" / f"category-{CATEGORY_ID}" / "images"
WEBP_MAX_WIDTH = 800
WEBP_QUALITY = 82
```

И функцию рядом с `download_image`:
```python
def convert_to_webp(src, dest):
    """Сделать из скачанного JPEG webp-версию для сайта.

    Ширину режем до WEBP_MAX_WIDTH: исходники 1006px, а на странице картинка
    показывается уже. Основная экономия веса именно от уменьшения — сам по себе
    WebP на уже сжатом JPEG даёт всего ~2.3x. Ниже 800px не опускаемся: на схемах
    перестают читаться дорожные знаки, а нечитаемый знак — это неверный ответ ученика.
    """
    if dest.exists() and verify_image(dest):
        return True

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        with Image.open(src) as image:
            converted = image.convert("RGB")
            if converted.width > WEBP_MAX_WIDTH:
                height = round(converted.height * WEBP_MAX_WIDTH / converted.width)
                converted = converted.resize((WEBP_MAX_WIDTH, height), Image.LANCZOS)
            converted.save(tmp, format="WEBP", quality=WEBP_QUALITY, method=6)
        if not verify_image(tmp):
            return False
        os.replace(tmp, dest)
        return True
    except Exception:
        return False
    finally:
        tmp.unlink(missing_ok=True)
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: все зелёные, включая 6 новых.

- [ ] **Step 5: Самопроверка мутацией**

Убери `if converted.width > WEBP_MAX_WIDTH:` (пусть не уменьшает) → `test_convert_to_webp_shrinks_wide_image` должен упасть. Верни обратно.

- [ ] **Step 6: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: конвертация картинок билетов в WebP с уменьшением до 800px"
```

---

### Task 2: Парсер кладёт в репозиторий только WebP

**Files:**
- Modify: `tools/parse_tickets.py` (функция `collect`)
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающий тест**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
def test_collect_stores_webp_path_and_keeps_jpeg_in_cache(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(pt, "CACHE_IMAGES_DIR", tmp_path / "cache" / "images")
    monkeypatch.setattr(pt, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(pt, "IMAGES_DIR", tmp_path / "data" / "tickets" / "images")
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)

    session = FlakySession(html_ru)
    monkeypatch.setattr(
        session, "get", lambda url, **kw: FakeResponse(_write_jpeg_bytes())
        if url.endswith(".jpg")
        else FakeResponse(html_ru.encode("utf-8"), content_type="text/html"),
        raising=False,
    )

    tickets, _total, _pages_seen, _page_count = pt.collect(session)
    with_image = [t for t in tickets if t["image"]]
    assert with_image, "в фикстуре есть билеты с картинками"
    for ticket in with_image:
        assert ticket["image"].endswith(".webp")
        assert (tmp_path / "data" / ticket["image"]).exists()
    assert not list((tmp_path / "data" / "tickets" / "images").glob("*.jpg"))
    assert list((tmp_path / "cache" / "images").glob("*.jpg")), "JPEG остаётся в кэше"
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k collect_stores_webp -v
```
Ожидаемо: FAIL — сейчас `collect` кладёт `.jpg` прямо в `IMAGES_DIR`.

- [ ] **Step 3: Переписать блок картинок в `collect`**

Заменить существующий цикл скачивания картинок в `collect()` на:
```python
    for ticket in tickets:
        ticket["image"] = None
        if not ticket["image_url"]:
            continue
        # Имя берём из пути URL, а не из хвоста строки: query-параметр
        # превратился бы в часть имени файла.
        filename = Path(urlparse(ticket["image_url"]).path).name
        cached_jpeg = CACHE_IMAGES_DIR / filename
        webp = IMAGES_DIR / f"{cached_jpeg.stem}.webp"
        downloaded = download_image(session, ticket["image_url"], cached_jpeg)
        if downloaded and convert_to_webp(cached_jpeg, webp):
            ticket["image"] = str(webp.relative_to(DATA_DIR))
        else:
            print(f"  ! билет {ticket['id']}: картинка не получена ({ticket['image_url']})")
```

- [ ] **Step 4: Запустить все тесты**

```bash
.venv/bin/python -m pytest tools/tests/ -v
```
Ожидаемо: все зелёные.

- [ ] **Step 5: Commit кода**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: в репозиторий попадают только WebP, JPEG остаётся в кэше"
```

- [ ] **Step 6: Перенести уже скачанные JPEG в кэш, не качая заново**

```bash
mkdir -p tools/.cache/category-2/images
git rm -r --cached -q data/tickets/images
mv data/tickets/images/*.jpg tools/.cache/category-2/images/
ls tools/.cache/category-2/images | wc -l
```
Ожидаемо: 524

- [ ] **Step 7: Перегенерировать базу**

```bash
.venv/bin/python -m tools.parse_tickets 2>&1 | tail -3
```
Ожидаемо: `Готово: 921 билетов (524 с картинками)`. Страницы и JPEG берутся из кэша, сеть почти не используется; конвертация 524 картинок займёт минуту-другую.

- [ ] **Step 8: Проверить результат независимо**

```bash
.venv/bin/python - <<'EOF'
import json, pathlib
d = json.loads(pathlib.Path("data/tickets-b-ru.json").read_text(encoding="utf-8"))
t = d["tickets"]
imgs = list(pathlib.Path("data/tickets/images").glob("*"))
print("билетов:", len(t), "| с картинками:", sum(1 for x in t if x["image"]))
print("файлов:", len(imgs), "| из них не webp:", [p.name for p in imgs if p.suffix != ".webp"][:5])
print("битых путей:", sum(1 for x in t if x["image"] and not (pathlib.Path("data")/x["image"]).exists()))
print("ссылок на jpg в JSON:", sum(1 for x in t if x["image"] and x["image"].endswith(".jpg")))
EOF
du -sh data/tickets/images
```
Ожидаемо: 921 билет, 524 картинки, все `.webp`, битых путей 0, ссылок на jpg 0, объём около 21 МБ.

- [ ] **Step 9: Commit данных**

```bash
git add data
git commit -m "feat: картинки билетов переведены в WebP — 66 МБ стало ~21 МБ"
```

---

### Task 3: Логика экзамена

**Files:**
- Create: `package.json`
- Create: `js/exam-logic.js`
- Test: `js/tests/exam-logic.test.js`

- [ ] **Step 1: Создать package.json**

Нужен только чтобы node считал `.js` модулями ESM и дал короткую команду тестов.
```json
{
  "name": "avtoshkola-ge",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test js/tests/"
  }
}
```

- [ ] **Step 2: Написать падающие тесты**

`js/tests/exam-logic.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MISTAKES,
  QUESTION_COUNT,
  examVerdict,
  formatTime,
  isCorrect,
  selectExamTickets,
} from "../exam-logic.js";

function makeTickets(count, lang = "ru") {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    lang,
    question: `Вопрос ${index + 1}`,
    answers: ["А", "Б"],
    correct: 0,
    image: null,
  }));
}

test("выборка возвращает ровно 30 билетов", () => {
  const picked = selectExamTickets(makeTickets(200));
  assert.equal(picked.length, QUESTION_COUNT);
});

test("в выборке нет повторов", () => {
  const picked = selectExamTickets(makeTickets(200));
  assert.equal(new Set(picked.map((t) => t.id)).size, QUESTION_COUNT);
});

test("грузинские билеты в выборку не попадают", () => {
  const pool = [...makeTickets(40, "ru"), ...makeTickets(40, "ka")];
  const picked = selectExamTickets(pool);
  assert.ok(picked.every((t) => t.lang === "ru"));
});

test("при нехватке русских билетов выборка падает с внятной ошибкой", () => {
  const pool = [...makeTickets(5, "ru"), ...makeTickets(100, "ka")];
  assert.throws(() => selectExamTickets(pool), /русских билетов 5/);
});

test("проверка ответа сравнивает индекс с полем correct", () => {
  const ticket = { correct: 2 };
  assert.equal(isCorrect(ticket, 2), true);
  assert.equal(isCorrect(ticket, 0), false);
});

test("три ошибки — сдал", () => {
  const verdict = examVerdict({ answered: QUESTION_COUNT, mistakes: MAX_MISTAKES, timeUp: false });
  assert.equal(verdict.passed, true);
});

test("четыре ошибки — не сдал", () => {
  const verdict = examVerdict({ answered: 12, mistakes: MAX_MISTAKES + 1, timeUp: false });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "mistakes");
});

test("время вышло с неотвеченными вопросами — не сдал", () => {
  const verdict = examVerdict({ answered: 20, mistakes: 0, timeUp: true });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "time");
});

test("все 30 без ошибок — сдал", () => {
  const verdict = examVerdict({ answered: QUESTION_COUNT, mistakes: 0, timeUp: false });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "completed");
});

test("формат таймера", () => {
  assert.equal(formatTime(1800), "30:00");
  assert.equal(formatTime(65), "01:05");
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(-5), "00:00");
});
```

- [ ] **Step 3: Запустить тесты, убедиться что падают**

```bash
npm test
```
Ожидаемо: FAIL — `Cannot find module .../js/exam-logic.js`

- [ ] **Step 4: Написать реализацию**

`js/exam-logic.js`:
```js
// Чистая логика экзамена: ни одного обращения к DOM.
// Отделена от интерфейса ровно затем, чтобы её можно было проверить
// в node --test без браузера.

export const QUESTION_COUNT = 30;
export const MAX_MISTAKES = 3;
export const TIME_LIMIT_SEC = 30 * 60;

/**
 * Случайные билеты для одной попытки.
 * Грузинские билеты отсеиваются: ученик не должен получить вопрос,
 * который не может прочитать.
 */
export function selectExamTickets(tickets, random = Math.random) {
  const pool = tickets.filter((ticket) => ticket.lang === "ru");
  if (pool.length < QUESTION_COUNT) {
    throw new Error(`русских билетов ${pool.length}, нужно минимум ${QUESTION_COUNT}`);
  }

  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, QUESTION_COUNT);
}

export function isCorrect(ticket, answerIndex) {
  return ticket.correct === answerIndex;
}

/**
 * Итог попытки. Правила настоящего экзамена: 30 вопросов, максимум 3 ошибки,
 * не уложился по времени — не сдал.
 */
export function examVerdict({ answered, mistakes, timeUp }) {
  if (mistakes > MAX_MISTAKES) {
    return { passed: false, reason: "mistakes" };
  }
  if (answered < QUESTION_COUNT) {
    return { passed: false, reason: timeUp ? "time" : "unfinished" };
  }
  return { passed: true, reason: "completed" };
}

export function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(safe / 60)).padStart(2, "0");
  const rest = String(safe % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}
```

- [ ] **Step 5: Запустить тесты**

```bash
npm test
```
Ожидаемо: `# pass 10`, `# fail 0`

- [ ] **Step 6: Самопроверка мутациями**

Сломай по очереди, каждый раз убеждаясь в красном и возвращая обратно:
1. в `selectExamTickets` убери `.filter(...)` → падает тест про грузинские билеты;
2. в `examVerdict` замени `mistakes > MAX_MISTAKES` на `mistakes >= MAX_MISTAKES` → падает тест «три ошибки — сдал».

- [ ] **Step 7: Commit**

```bash
git add package.json js/exam-logic.js js/tests/exam-logic.test.js
git commit -m "feat: логика экзамена по билетам — выборка, вердикт, таймер"
```

---

### Task 4: Страница экзамена — разметка и стили

**Files:**
- Create: `bilety/index.html`
- Create: `css/exam.css`

- [ ] **Step 1: Создать `bilety/index.html`**

Шапка и подвал повторяют разметку главной (`index.html`, строки 190-193 и 372-386), чтобы страница не выглядела чужой. Пути к ресурсам — на уровень выше (`../`).

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>Билеты ПДД Грузии онлайн на русском — экзамен 2026 | Автошкола Тбилиси</title>
  <meta name="description" content="Экзамен по билетам ПДД Грузии на русском языке: 30 вопросов, 30 минут, до 3 ошибок — как на настоящем экзамене. Бесплатно, без регистрации.">
  <link rel="canonical" href="https://avtoshkola.ge/bilety/">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#faf9f6">

  <meta property="og:type" content="website">
  <meta property="og:url" content="https://avtoshkola.ge/bilety/">
  <meta property="og:site_name" content="Автошкола на русском языке — Тбилиси">
  <meta property="og:locale" content="ru_RU">
  <meta property="og:title" content="Билеты ПДД Грузии онлайн на русском — экзамен">
  <meta property="og:description" content="30 вопросов, 30 минут, до 3 ошибок — как на настоящем экзамене в Грузии. Бесплатно.">
  <meta property="og:image" content="https://avtoshkola.ge/media/og-image.jpg">
  <meta name="twitter:card" content="summary_large_image">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;900&family=Golos+Text:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/tokens.css?v=13">
  <link rel="stylesheet" href="../css/style.css?v=13">
  <link rel="stylesheet" href="../css/exam.css?v=1">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='18' fill='%23161a24'/><rect x='14' y='46' width='24' height='8' rx='2' fill='%23f2b23e'/><rect x='46' y='46' width='24' height='8' rx='2' fill='%23f2b23e'/><rect x='78' y='46' width='10' height='8' rx='2' fill='%23f2b23e'/></svg>">

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Quiz",
    "name": "Экзамен по билетам ПДД Грузии на русском языке",
    "about": "Правила дорожного движения Грузии, категория B",
    "educationalLevel": "Подготовка к теоретическому экзамену на права категории B",
    "inLanguage": "ru",
    "url": "https://avtoshkola.ge/bilety/"
  }
  </script>
</head>
<body>
  <header class="nav">
    <a class="nav__brand" href="../">Автошкола<span class="nav__brand-dot">·</span>Тбилиси</a>
    <a class="nav__cta" href="tel:+995599987707">599 98 77 07</a>
  </header>

  <main class="exam" id="exam">
    <!-- Экран 1: старт -->
    <section class="exam__screen exam__intro" id="screen-intro">
      <h1 class="exam__title">Билеты ПДД Грузии на русском</h1>
      <p class="exam__lead">
        Экзамен идёт по правилам настоящего: 30 вопросов, 30 минут,
        допустимо не больше трёх ошибок. Регистрация не нужна.
      </p>
      <dl class="exam__rules">
        <div class="exam__rule"><dt>Вопросов</dt><dd>30</dd></div>
        <div class="exam__rule"><dt>Времени</dt><dd>30 минут</dd></div>
        <div class="exam__rule"><dt>Ошибок можно</dt><dd>не больше 3</dd></div>
      </dl>
      <button class="exam__btn exam__btn--primary" id="btn-start" type="button">Начать экзамен</button>
      <p class="exam__status" id="intro-status" role="status">Загружаем билеты…</p>
    </section>

    <!-- Экран 2: вопрос -->
    <section class="exam__screen exam__quiz" id="screen-quiz" hidden>
      <div class="exam__bar">
        <span class="exam__counter">Вопрос <b id="q-index">1</b> из <b id="q-total">30</b></span>
        <span class="exam__timer" id="q-timer">30:00</span>
        <span class="exam__mistakes">Ошибок: <b id="q-mistakes">0</b> из 3</span>
      </div>
      <div class="exam__progress"><div class="exam__progress-fill" id="q-progress"></div></div>

      <h2 class="exam__question" id="q-text" tabindex="-1"></h2>
      <figure class="exam__figure" id="q-figure" hidden>
        <img class="exam__image" id="q-image" src="" alt="Изображение к вопросу билета">
      </figure>

      <ul class="exam__answers" id="q-answers"></ul>

      <p class="exam__feedback" id="q-feedback" role="status" aria-live="polite"></p>
      <button class="exam__btn exam__btn--primary" id="btn-next" type="button" hidden>Дальше</button>
      <p class="exam__hint">Ответ — клавиши 1–4, дальше — Enter</p>
    </section>

    <!-- Экран 3: результат -->
    <section class="exam__screen exam__result" id="screen-result" hidden>
      <h2 class="exam__verdict" id="r-verdict"></h2>
      <p class="exam__summary" id="r-summary"></p>
      <div class="exam__actions">
        <button class="exam__btn exam__btn--primary" id="btn-restart" type="button">Пройти ещё раз</button>
        <a class="exam__btn exam__btn--ghost" href="../#callback-form">Записаться на курс</a>
      </div>
      <h3 class="exam__mistakes-title" id="r-mistakes-title" hidden>Разбор ошибок</h3>
      <ol class="exam__review" id="r-review"></ol>
    </section>

    <p class="exam__source">
      Вопросы и изображения — официальные экзаменационные билеты Грузии,
      источник: <a href="https://teoria.on.ge" rel="nofollow noopener" target="_blank">teoria.on.ge</a>.
      Тема «эко-вождение» (51 билет) на реальном экзамене существует только на грузинском,
      поэтому в тренажёр она не включена.
    </p>
  </main>

  <footer class="footer">
    <p class="footer__mark">Автошкола на русском языке</p>
    <p class="footer__tagline">Полный курс ПДД и вождение — Тбилиси, Грузия</p>
    <p class="footer__meta">
      <a href="https://www.facebook.com/avtoshkolatbilisi" rel="noopener">Facebook</a>
      <span aria-hidden="true">·</span>
      <a href="tel:+995599987707">+995 599 98 77 07</a>
      <span aria-hidden="true">·</span>
      <span>Пр-т Важа Пшавела 9, Тбилиси</span>
    </p>
  </footer>

  <script type="module" src="../js/exam.js?v=1"></script>
</body>
</html>
```

- [ ] **Step 2: Создать `css/exam.css`**

Цвета, шрифты и отступы берутся из `css/tokens.css` — своих значений не изобретаем.
```css
/* Страница экзамена. Токены — из css/tokens.css. */

.exam {
  max-width: 52rem;
  margin: 0 auto;
  padding: var(--space-2xl) var(--space-md) var(--space-3xl);
}

.exam__screen[hidden] { display: none; }

.exam__title {
  font-family: var(--font-display);
  font-size: var(--text-display-s);
  margin: 0 0 var(--space-sm);
}

.exam__lead {
  font-size: var(--text-lg);
  color: var(--color-ink-muted);
  margin: 0 0 var(--space-lg);
  max-width: 40rem;
}

.exam__rules {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  margin: 0 0 var(--space-lg);
  padding: 0;
}

.exam__rule {
  border: var(--rule-hair) solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  min-width: 8rem;
}

.exam__rule dt {
  font-size: var(--text-xs);
  color: var(--color-ink-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.exam__rule dd {
  margin: var(--space-2xs) 0 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.exam__btn {
  display: inline-block;
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-lg);
  font-family: var(--font-body);
  font-size: var(--text-md);
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  transition: transform var(--dur-short) var(--ease-out);
}

.exam__btn:hover { transform: translateY(-1px); }
.exam__btn:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }

.exam__btn--primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.exam__btn--ghost {
  background: transparent;
  color: var(--color-ink);
  border: var(--rule-hair) solid var(--color-line-strong);
}

.exam__btn[disabled] { opacity: 0.5; cursor: progress; transform: none; }

.exam__status { color: var(--color-ink-faint); font-size: var(--text-sm); margin-top: var(--space-sm); }
.exam__status--error { color: var(--color-error); }

/* --- Вопрос --- */

.exam__bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm) var(--space-lg);
  align-items: baseline;
  font-size: var(--text-sm);
  color: var(--color-ink-muted);
}

.exam__timer {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--color-ink);
}

.exam__timer--urgent { color: var(--color-error); }

.exam__progress {
  height: 4px;
  background: var(--color-line);
  border-radius: 2px;
  margin: var(--space-sm) 0 var(--space-lg);
  overflow: hidden;
}

.exam__progress-fill {
  height: 100%;
  width: 0;
  background: var(--color-accent);
  transition: width var(--dur-med) var(--ease-out);
}

.exam__question {
  font-family: var(--font-display);
  font-size: var(--text-xl);
  line-height: 1.3;
  margin: 0 0 var(--space-md);
}

.exam__question:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 4px; }

.exam__figure { margin: 0 0 var(--space-lg); }

.exam__image {
  width: 100%;
  height: auto;
  border-radius: var(--radius-md);
  display: block;
  background: var(--color-paper-2);
}

.exam__answers { list-style: none; margin: 0 0 var(--space-md); padding: 0; display: grid; gap: var(--space-xs); }

.exam__answer {
  width: 100%;
  text-align: left;
  display: flex;
  gap: var(--space-sm);
  align-items: baseline;
  background: var(--color-paper-2);
  border: var(--rule-hair) solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-md);
  font-family: var(--font-body);
  font-size: var(--text-md);
  color: var(--color-ink);
  cursor: pointer;
}

.exam__answer:hover:not([disabled]) { border-color: var(--color-line-strong); }
.exam__answer:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
.exam__answer[disabled] { cursor: default; }

.exam__answer-num {
  font-weight: 700;
  color: var(--color-ink-faint);
  min-width: 1.2em;
}

.exam__answer--correct {
  border-color: var(--color-success);
  background: color-mix(in oklch, var(--color-success) 12%, var(--color-paper-2));
}

.exam__answer--wrong {
  border-color: var(--color-error);
  background: color-mix(in oklch, var(--color-error) 12%, var(--color-paper-2));
}

.exam__feedback { min-height: 1.5em; font-weight: 600; margin: 0 0 var(--space-md); }
.exam__feedback--ok { color: var(--color-success); }
.exam__feedback--bad { color: var(--color-error); }

.exam__hint { font-size: var(--text-xs); color: var(--color-ink-faint); margin-top: var(--space-sm); }

/* --- Результат --- */

.exam__verdict { font-family: var(--font-display); font-size: var(--text-2xl); margin: 0 0 var(--space-sm); }
.exam__verdict--pass { color: var(--color-success); }
.exam__verdict--fail { color: var(--color-error); }
.exam__summary { font-size: var(--text-lg); color: var(--color-ink-muted); margin: 0 0 var(--space-lg); }
.exam__actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin-bottom: var(--space-2xl); }
.exam__mistakes-title { font-family: var(--font-display); font-size: var(--text-lg); margin: 0 0 var(--space-md); }
.exam__review { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-lg); }

.exam__review-item {
  border-top: var(--rule-hair) solid var(--color-line);
  padding-top: var(--space-md);
}

.exam__review-q { font-weight: 600; margin: 0 0 var(--space-xs); }
.exam__review-img { width: 100%; max-width: 26rem; height: auto; border-radius: var(--radius-sm); display: block; margin-bottom: var(--space-xs); }
.exam__review-line { margin: var(--space-2xs) 0; font-size: var(--text-sm); }
.exam__review-line b { font-weight: 600; }
.exam__review-line--wrong { color: var(--color-error); }
.exam__review-line--right { color: var(--color-success); }

.exam__source {
  margin-top: var(--space-3xl);
  font-size: var(--text-xs);
  color: var(--color-ink-faint);
  max-width: 44rem;
}

@media (max-width: 480px) {
  .exam { padding: var(--space-lg) var(--space-sm) var(--space-2xl); }
  .exam__bar { font-size: var(--text-xs); }
  .exam__btn { width: 100%; text-align: center; }
}
```

- [ ] **Step 3: Commit**

```bash
git add bilety/index.html css/exam.css
git commit -m "feat: страница экзамена — разметка и стили"
```

---

### Task 5: Интерфейс экзамена

**Files:**
- Create: `js/exam.js`

- [ ] **Step 1: Написать `js/exam.js`**

```js
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
    const ready = state.pool.filter((t) => t.lang === "ru").length;
    status.textContent = `Готово: ${ready} билетов на русском`;
    startButton.disabled = false;
  } catch (error) {
    status.textContent = `Не удалось загрузить билеты: ${error.message}. Обновите страницу.`;
    status.classList.add("exam__status--error");
  }
})();
```

- [ ] **Step 2: Проверить, что тесты логики по-прежнему зелёные**

```bash
npm test
```
Ожидаемо: `# pass 10`

- [ ] **Step 3: Commit**

```bash
git add js/exam.js
git commit -m "feat: интерфейс экзамена — вопросы, таймер, разбор ошибок"
```

---

### Task 6: Ссылки с сайта и SEO

**Files:**
- Modify: `index.html`
- Modify: `sitemap.xml`
- Modify: `llms.txt`

- [ ] **Step 1: Добавить ссылку в шапку главной**

В `index.html` в блоке `<header class="nav">` (строки 190-193) добавить ссылку между брендом и телефоном:
```html
    <a class="nav__link" href="bilety/">Билеты ПДД</a>
```
Если в `css/style.css` нет класса `nav__link`, добавить туда:
```css
.nav__link {
  color: var(--color-ink);
  text-decoration: none;
  font-size: var(--text-sm);
  font-weight: 600;
  margin-left: auto;
  margin-right: var(--space-md);
}

.nav__link:hover { text-decoration: underline; }
```

- [ ] **Step 2: Добавить кнопку в блок программы обучения**

В `index.html` в секции `<section class="steps" id="program">` (строка 248) в конец секции, перед закрывающим тегом:
```html
    <p class="steps__cta">
      <a class="exam-link" href="bilety/">Проверить себя на билетах ПДД →</a>
    </p>
```
И в `css/style.css`:
```css
.steps__cta { margin-top: var(--space-lg); }

.exam-link {
  font-weight: 600;
  color: var(--color-accent-deep);
  text-decoration: none;
  border-bottom: 2px solid var(--color-accent);
  padding-bottom: 2px;
}

.exam-link:hover { color: var(--color-ink); }
```

- [ ] **Step 3: Добавить страницу в sitemap.xml**

Открыть `sitemap.xml`, скопировать формат существующей записи и добавить рядом:
```xml
  <url>
    <loc>https://avtoshkola.ge/bilety/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
```
Дату `lastmod` поставить сегодняшнюю, если у существующей записи она есть.

- [ ] **Step 4: Дополнить llms.txt**

Добавить в `llms.txt` строку про новый раздел, в стиле существующих записей:
```
- [Билеты ПДД Грузии онлайн](https://avtoshkola.ge/bilety/): бесплатный экзамен на русском языке — 30 вопросов, 30 минут, до 3 ошибок, как на настоящем экзамене.
```

- [ ] **Step 5: Проверить, что ничего не сломалось в разметке**

```bash
.venv/bin/python -c "
import xml.dom.minidom
xml.dom.minidom.parse('sitemap.xml')
print('sitemap.xml — валидный XML')
"
grep -c 'bilety' index.html sitemap.xml llms.txt
```
Ожидаемо: XML валиден, в каждом файле есть упоминание `bilety`.

- [ ] **Step 6: Commit**

```bash
git add index.html css/style.css sitemap.xml llms.txt
git commit -m "feat: ссылки на раздел билетов с главной, sitemap и llms.txt"
```

---

### Task 7: Проверка в браузере

Тесты логики браузер не покрывают. Здесь проверяем то, что видит ученик.

- [ ] **Step 1: Поднять локальный сервер**

Через `.claude/launch.json` (конфигурация уже есть в проекте) или:
```bash
python3 -m http.server 8765
```

- [ ] **Step 2: Открыть `/bilety/` и проверить сценарий целиком**

1. страница открывается, статус меняется на «Готово: 870 билетов на русском», кнопка становится активной;
2. «Начать экзамен» — появляется первый вопрос, таймер идёт вниз от 30:00;
3. верный ответ — зелёная подсветка и «Верно»;
4. неверный — красная подсветка выбранного, зелёная у правильного, счётчик ошибок растёт;
5. «Дальше» и клавиша Enter переключают вопрос, счётчик «Вопрос N из 30» растёт, полоса прогресса движется;
6. клавиши 1–4 выбирают ответ;
7. картинки показываются и не растягиваются.

- [ ] **Step 3: Проверить консоль и сеть**

Ошибок в консоли быть не должно. В сети — один запрос за `tickets-b-ru.json` и по одному за картинку.

- [ ] **Step 4: Проверить досрочное завершение**

Быстро ответить неверно 4 раза подряд → экзамен обрывается, вердикт «Экзамен не сдан», причина про ошибки, ниже разбор всех четырёх с картинками.

- [ ] **Step 5: Проверить мобильный вид**

Ширина 375px: текст не вылезает, кнопки на всю ширину, картинка вписывается, панель со счётчиками переносится аккуратно.

- [ ] **Step 6: Снять скриншоты**

Desktop и mobile: экран старта, вопрос с картинкой, результат с разбором.

- [ ] **Step 7: Проверить, что главная не сломалась**

Открыть `/`, убедиться: ссылка «Билеты ПДД» в шапке на месте и ведёт куда надо, кнопка в блоке программы работает, остальная страница выглядит как раньше.

- [ ] **Step 8: Финальный прогон тестов**

```bash
npm test && .venv/bin/python -m pytest tools/tests/ -q
```
Ожидаемо: логика 10 passed, парсер — все зелёные.

---

## Итог

После Task 7 в ветке `dev`:
- `/bilety/` — работающий экзамен на 870 русских билетах;
- картинки в WebP, `data/` весит около 21 МБ вместо 66 МБ;
- логика экзамена покрыта тестами без браузера;
- главная получила ссылки на раздел, sitemap и llms.txt обновлены.

Следующий возможный шаг (отдельным спеком): режим свободной тренировки по всем билетам с фильтром по темам.
