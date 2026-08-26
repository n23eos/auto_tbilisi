# Парсер базы билетов ПДД — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать `data/tickets-b-ru.json` — 921 билет ПДД Грузии (категория B/B1, русский) с локальными картинками, с проверками качества базы.

**Architecture:** Один Python-скрипт `tools/parse_tickets.py` с чистыми функциями разбора HTML (тестируются на фикстурах, без сети) и тонким сетевым слоем поверх. Данные собираются в памяти, валидируются, и только после успешной валидации атомарно записываются в JSON. Сайт (`index.html`, css, js) не трогаем.

**Tech Stack:** Python 3, requests, beautifulsoup4, Pillow, pytest.

**Spec:** `docs/superpowers/specs/2026-08-26-pdd-tickets-db-design.md`

**Ветка:** `dev`. В `main` ничего не мержим.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `tools/parse_tickets.py` | Константы, разбор HTML, валидация, кэш, скачивание картинок, `main()` |
| `tools/requirements.txt` | requests, beautifulsoup4, Pillow |
| `tools/requirements-dev.txt` | `-r requirements.txt` + pytest |
| `tools/tests/fixtures/tickets-page-ru.html` | Фикстура страницы списка (4 билета, все интересные случаи) |
| `tools/tests/fixtures/tickets-page-ka.html` | Фикстура с чужой локалью — для проверки отбраковки кэша |
| `tools/tests/test_parse_tickets.py` | Все тесты |
| `data/tickets-b-ru.json` | Результат (создаётся Task 10) |
| `data/tickets/images/*.jpg` | Картинки (создаются Task 10) |

Всё разбирающее HTML — чистые функции, принимают строку, возвращают данные. Сеть только в `fetch_page` и `download_image`.

---

### Task 1: Каркас и зависимости

**Files:**
- Create: `tools/requirements.txt`
- Create: `tools/requirements-dev.txt`
- Create: `tools/tests/__init__.py` (пустой)

- [ ] **Step 1: Создать файлы зависимостей**

`tools/requirements.txt`:
```
requests>=2.31
beautifulsoup4>=4.12
Pillow>=10.0
```

`tools/requirements-dev.txt`:
```
-r requirements.txt
pytest>=8.0
```

- [ ] **Step 2: Создать venv и поставить зависимости**

```bash
python3 -m venv .venv && .venv/bin/pip install -q -r tools/requirements-dev.txt && .venv/bin/python -c "import bs4, requests, PIL, pytest; print('deps ok')"
```
Ожидаемо: `deps ok`

- [ ] **Step 3: Убедиться, что venv не попадёт в git**

```bash
grep -q '^\.venv/' .gitignore || printf '.venv/\n' >> .gitignore
cat .gitignore
```
Ожидаемо: в списке есть `.venv/` и `tools/.cache/`

- [ ] **Step 4: Пустой пакет тестов**

```bash
mkdir -p tools/tests/fixtures && touch tools/tests/__init__.py
```

- [ ] **Step 5: Commit**

```bash
git add tools/requirements.txt tools/requirements-dev.txt tools/tests/__init__.py .gitignore
git commit -m "chore: зависимости и каркас для парсера билетов"
```

---

### Task 2: Фикстуры HTML

Фикстуры написаны вручную и повторяют реальную вёрстку teoria.on.ge. Сеть при прогоне тестов не нужна.

Четыре билета покрывают: картинка по `http://`, отсутствие картинки, протокол-относительный `//`, относительный путь, пустые слоты `ans-empty`, отсутствие метки правильного ответа.

**Files:**
- Create: `tools/tests/fixtures/tickets-page-ru.html`
- Create: `tools/tests/fixtures/tickets-page-ka.html`

- [ ] **Step 1: Создать русскую фикстуру**

`tools/tests/fixtures/tickets-page-ru.html`:
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>fixture</title></head><body>
<ul class="menu" data-active="/tickets/2" data-category-link-pattern="/tickets/{CAT}"></ul>
<div class="text-content"><h1>B, B1 კატეგორია <span class="light">სულ 921 ბილეთი, გვერდი 1</span></h1></div>
<nav class="on-pagination">
  <select class="form-control paginator-select" data-href="/tickets/2?page=">
    <option class="noaction" selected="selected" value="1">- გვერდი 1 -</option>
    <option value="2">გვერდი 2</option>
    <option value="3">გვერდი 3</option>
  </select>
</nav>

<article class="ticket-container locale-ru hovering">
  <figure class="t-image"><img src="http://teoria.on.ge/files/new/aaa111.jpg" alt=""></figure>
  <div class="t-num">#1</div>
  <div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос один</span></p></div>
  <div class="t-cover answers-num-2">
    <p class="t-answer t-answer-1   " ><span class="t-answer-inner"><span class="t-a-num"><span>1</span></span><span class="t-a-text"><span class="text-wrap">Ответ 1-1</span></span></span></p>
    <p class="t-answer t-answer-2   " data-is-correct-list="true"><span class="t-answer-inner"><span class="t-a-num"><span>2</span></span><span class="t-a-text"><span class="text-wrap">Ответ 1-2</span></span></span></p>
    <p class="t-answer t-answer-3  ans-empty " ></p>
    <p class="t-answer t-answer-4  ans-empty " ></p>
  </div>
</article>

<article class="ticket-container locale-ru hovering">
  <div class="t-num">#2</div>
  <div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос два</span></p></div>
  <div class="t-cover answers-num-3">
    <p class="t-answer t-answer-1   " data-is-correct-list="true"><span class="t-answer-inner"><span class="t-a-num"><span>1</span></span><span class="t-a-text"><span class="text-wrap">Ответ 2-1</span></span></span></p>
    <p class="t-answer t-answer-2   " ><span class="t-answer-inner"><span class="t-a-num"><span>2</span></span><span class="t-a-text"><span class="text-wrap">Ответ 2-2</span></span></span></p>
    <p class="t-answer t-answer-3   " ><span class="t-answer-inner"><span class="t-a-num"><span>3</span></span><span class="t-a-text"><span class="text-wrap">Ответ 2-3</span></span></span></p>
    <p class="t-answer t-answer-4  ans-empty " ></p>
  </div>
</article>

<article class="ticket-container locale-ru hovering">
  <figure class="t-image"><img src="//static.on.ge/teoria/ccc333.jpg" alt=""></figure>
  <div class="t-num">#4</div>
  <div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос четыре</span></p></div>
  <div class="t-cover answers-num-2">
    <p class="t-answer t-answer-1   " data-is-correct-list="true"><span class="t-answer-inner"><span class="t-a-num"><span>1</span></span><span class="t-a-text"><span class="text-wrap">Ответ 4-1</span></span></span></p>
    <p class="t-answer t-answer-2   " ><span class="t-answer-inner"><span class="t-a-num"><span>2</span></span><span class="t-a-text"><span class="text-wrap">Ответ 4-2</span></span></span></p>
  </div>
</article>

<article class="ticket-container locale-ru hovering">
  <figure class="t-image"><img src="/files/new/ddd444.jpg" alt=""></figure>
  <div class="t-num">#7</div>
  <div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос семь без метки</span></p></div>
  <div class="t-cover answers-num-2">
    <p class="t-answer t-answer-1   " ><span class="t-answer-inner"><span class="t-a-num"><span>1</span></span><span class="t-a-text"><span class="text-wrap">Ответ 7-1</span></span></span></p>
    <p class="t-answer t-answer-2   " ><span class="t-answer-inner"><span class="t-a-num"><span>2</span></span><span class="t-a-text"><span class="text-wrap">Ответ 7-2</span></span></span></p>
  </div>
</article>
</body></html>
```

- [ ] **Step 2: Создать грузинскую фикстуру (для отбраковки кэша)**

`tools/tests/fixtures/tickets-page-ka.html`:
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>fixture ka</title></head><body>
<ul class="menu" data-active="/tickets/2"></ul>
<div class="text-content"><h1>B, B1 კატეგორია <span class="light">სულ 921 ბილეთი, გვერდი 1</span></h1></div>
<article class="ticket-container locale-ka hovering">
  <div class="t-num">#1</div>
  <div class="t-question"><p class="t-question-inner"><span class="text-wrap">კითხვა</span></p></div>
  <div class="t-cover answers-num-2">
    <p class="t-answer t-answer-1   " data-is-correct-list="true"><span class="t-answer-inner"><span class="t-a-text"><span class="text-wrap">პასუხი 1</span></span></span></p>
    <p class="t-answer t-answer-2   " ><span class="t-answer-inner"><span class="t-a-text"><span class="text-wrap">პასუხი 2</span></span></span></p>
  </div>
</article>
</body></html>
```

- [ ] **Step 3: Commit**

```bash
git add tools/tests/fixtures
git commit -m "test: фикстуры страниц teoria.on.ge для тестов парсера"
```

---

### Task 3: Константы и разбор шапки страницы

`parse_total` берёт общее число билетов из `<h1>` (после грузинского слова `სულ`), `parse_page_count` — максимальный `<option value>` из селектора пагинации.

**Files:**
- Create: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

`tools/tests/test_parse_tickets.py`:
```python
from pathlib import Path

import pytest

from tools import parse_tickets as pt

FIXTURES = Path(__file__).parent / "fixtures"
PAGE_URL = "https://teoria.on.ge/tickets/2?page=1"


@pytest.fixture
def html_ru():
    return (FIXTURES / "tickets-page-ru.html").read_text(encoding="utf-8")


@pytest.fixture
def html_ka():
    return (FIXTURES / "tickets-page-ka.html").read_text(encoding="utf-8")


def test_parse_total_reads_number_from_heading(html_ru):
    assert pt.parse_total(html_ru) == 921


def test_parse_total_raises_when_heading_missing():
    with pytest.raises(ValueError):
        pt.parse_total("<html><body>без заголовка</body></html>")


def test_parse_page_count_reads_max_option(html_ru):
    assert pt.parse_page_count(html_ru) == 3


def test_parse_page_count_defaults_to_one_without_paginator():
    html = "<html><body><h1>სულ 5 ბილეთი</h1></body></html>"
    assert pt.parse_page_count(html) == 1
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: FAIL — `ModuleNotFoundError: No module named 'tools.parse_tickets'`

- [ ] **Step 3: Написать минимальную реализацию**

`tools/parse_tickets.py`:
```python
"""Парсер экзаменационных билетов ПДД Грузии (категория B/B1, русский язык).

Источник: https://teoria.on.ge
Спека: docs/superpowers/specs/2026-08-26-pdd-tickets-db-design.md

Скрипт намеренно ограничен одной категорией и одним языком: значения ниже —
константы, из них выводятся URL, cookie, имя JSON и путь к картинкам.
"""

import re

from bs4 import BeautifulSoup

# --- Что парсим (менять здесь, а не по всему файлу) ---
CATEGORY_ID = 2
CATEGORY_LABELS = ["B", "B1"]
LOCALE = "ru"

BASE_URL = "https://teoria.on.ge"
LIST_URL = f"{BASE_URL}/tickets/{CATEGORY_ID}"

# В заголовке страницы общее число билетов идёт после грузинского слова "სულ" (всего).
TOTAL_RE = re.compile(r"სულ\s+(\d+)")


def parse_total(html):
    """Общее число билетов в категории, заявленное источником в <h1>."""
    match = TOTAL_RE.search(html)
    if not match:
        raise ValueError("не найдено общее число билетов в заголовке страницы")
    return int(match.group(1))


def parse_page_count(html):
    """Число страниц списка. Без селектора пагинации считаем, что страница одна."""
    soup = BeautifulSoup(html, "html.parser")
    select = soup.select_one("select.paginator-select")
    if select is None:
        return 1
    values = [
        int(option["value"])
        for option in select.select("option[value]")
        if option["value"].isdigit()
    ]
    return max(values) if values else 1
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 4 passed

- [ ] **Step 5: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: разбор шапки страницы билетов — всего билетов и число страниц"
```

---

### Task 4: Разбор билетов из HTML

`parse_tickets(html, page_url)` возвращает список словарей. Функция «тупая»: она только достаёт данные, ничего не отбрасывает молча и не судит о валидности — это дело валидатора (Task 5). Отсутствие метки правильного ответа даёт `correct: None`, а не потерянный билет.

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `tools/tests/test_parse_tickets.py`:
```python
def test_parse_tickets_returns_all_articles(html_ru):
    tickets = pt.parse_tickets(html_ru, PAGE_URL)
    assert [t["id"] for t in tickets] == [1, 2, 4, 7]


def test_parse_tickets_reads_question_and_answers(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert ticket["question"] == "Вопрос один"
    assert ticket["answers"] == ["Ответ 1-1", "Ответ 1-2"]
    assert ticket["correct"] == 1
    assert ticket["source"] == "https://teoria.on.ge/tickets?ticket=1"


def test_parse_tickets_skips_empty_answer_slots(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert len(ticket["answers"]) == 2


def test_parse_tickets_handles_ticket_without_image(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[1]
    assert ticket["image_url"] is None
    assert ticket["answers"] == ["Ответ 2-1", "Ответ 2-2", "Ответ 2-3"]
    assert ticket["correct"] == 0


def test_parse_tickets_resolves_absolute_image_url(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert ticket["image_url"] == "http://teoria.on.ge/files/new/aaa111.jpg"


def test_parse_tickets_resolves_protocol_relative_image_url(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[2]
    assert ticket["image_url"] == "https://static.on.ge/teoria/ccc333.jpg"


def test_parse_tickets_resolves_relative_image_url(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[3]
    assert ticket["image_url"] == "https://teoria.on.ge/files/new/ddd444.jpg"


def test_parse_tickets_keeps_ticket_without_correct_marker(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[3]
    assert ticket["id"] == 7
    assert ticket["correct"] is None
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'parse_tickets'`

- [ ] **Step 3: Написать реализацию**

В `tools/parse_tickets.py` добавить импорт вверху файла:
```python
from urllib.parse import urljoin
```

И функции в конец файла:
```python
def _clean_text(element):
    """Текст элемента одной строкой, без двойных пробелов и переносов."""
    if element is None:
        return ""
    return " ".join(element.get_text(" ", strip=True).split())


def _parse_ticket_id(article):
    """id билета из <div class="t-num">#123</div>. None, если распознать нельзя."""
    raw = _clean_text(article.select_one(".t-num")).lstrip("#")
    return int(raw) if raw.isdigit() else None


def _parse_answers(article):
    """Список ответов и индекс правильного (или None, если метки нет)."""
    answers = []
    correct = None
    for paragraph in article.select("p.t-answer"):
        # Пустые слоты (в разметке их всегда 4) помечены классом ans-empty.
        if "ans-empty" in paragraph.get("class", []):
            continue
        if paragraph.get("data-is-correct-list") == "true":
            correct = len(answers)
        answers.append(_clean_text(paragraph.select_one(".t-a-text")))
    return answers, correct


def parse_tickets(html, page_url):
    """Разобрать страницу списка в список билетов.

    Ничего не отбраковывает: билет с проблемой (нет id, пустой вопрос, нет метки
    правильного ответа) всё равно попадает в результат, чтобы валидатор о нём сообщил.
    """
    soup = BeautifulSoup(html, "html.parser")
    tickets = []
    for article in soup.select("article.ticket-container"):
        ticket_id = _parse_ticket_id(article)
        answers, correct = _parse_answers(article)
        image = article.select_one("figure.t-image img")
        image_src = image.get("src") if image is not None else None
        tickets.append(
            {
                "id": ticket_id,
                "question": _clean_text(article.select_one(".t-question-inner")),
                "answers": answers,
                "correct": correct,
                "image_url": urljoin(page_url, image_src) if image_src else None,
                "source": f"{BASE_URL}/tickets?ticket={ticket_id}",
            }
        )
    return tickets
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 13 passed

- [ ] **Step 5: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: разбор билетов из HTML — вопрос, ответы, правильный, картинка"
```

---

### Task 5: Валидация базы

Одна функция `validate(tickets, total, pages_seen, page_count)` возвращает список сообщений об ошибках. Пустой список = база годная. Проверка картинок на диске — отдельная функция в Task 7, здесь только то, что видно по данным.

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
def make_ticket(**overrides):
    """Заведомо валидный билет; поля переопределяются под конкретный тест."""
    ticket = {
        "id": 1,
        "question": "Вопрос",
        "answers": ["Ответ 1", "Ответ 2"],
        "correct": 0,
        "image_url": None,
        "image": None,
        "source": "https://teoria.on.ge/tickets?ticket=1",
    }
    ticket.update(overrides)
    return ticket


def test_validate_accepts_good_database():
    tickets = [make_ticket(id=1), make_ticket(id=2)]
    assert pt.validate(tickets, total=2, pages_seen={1: 2}, page_count=1) == []


def test_validate_catches_duplicate_ids():
    tickets = [make_ticket(id=5), make_ticket(id=5)]
    errors = pt.validate(tickets, total=2, pages_seen={1: 2}, page_count=1)
    assert any("дубл" in e for e in errors)


def test_validate_catches_empty_question():
    tickets = [make_ticket(question="")]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("вопрос" in e for e in errors)


def test_validate_catches_non_positive_id():
    tickets = [make_ticket(id=0)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("id" in e for e in errors)


def test_validate_catches_missing_id():
    tickets = [make_ticket(id=None)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("id" in e for e in errors)


def test_validate_catches_single_answer():
    tickets = [make_ticket(answers=["Только один"], correct=0)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("ответ" in e for e in errors)


def test_validate_catches_empty_answer_text():
    tickets = [make_ticket(answers=["Ответ 1", ""])]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("ответ" in e for e in errors)


def test_validate_catches_missing_correct():
    tickets = [make_ticket(correct=None)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("правильн" in e for e in errors)


def test_validate_catches_correct_out_of_range():
    tickets = [make_ticket(correct=2)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("правильн" in e for e in errors)


def test_validate_catches_correct_not_integer():
    tickets = [make_ticket(correct=True)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("правильн" in e for e in errors)


def test_validate_catches_ticket_count_mismatch():
    tickets = [make_ticket(id=1)]
    errors = pt.validate(tickets, total=921, pages_seen={1: 1}, page_count=1)
    assert any("921" in e for e in errors)


def test_validate_catches_missing_page():
    tickets = [make_ticket(id=1), make_ticket(id=2)]
    errors = pt.validate(tickets, total=2, pages_seen={1: 2}, page_count=3)
    assert any("страниц" in e for e in errors)


def test_validate_catches_empty_page():
    tickets = [make_ticket(id=1)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1, 2: 0}, page_count=2)
    assert any("пуст" in e for e in errors)


def test_validate_catches_lost_image():
    tickets = [make_ticket(image_url="https://teoria.on.ge/a.jpg", image=None)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("картинк" in e for e in errors)


def test_validate_allows_null_image_when_source_has_none():
    tickets = [make_ticket(image_url=None, image=None)]
    assert pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1) == []
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k validate -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'validate'`

- [ ] **Step 3: Написать реализацию**

Добавить в `tools/parse_tickets.py`:
```python
MIN_ANSWERS = 2


def _validate_ticket(ticket):
    """Ошибки одного билета. Пустой список = билет годный."""
    errors = []
    ticket_id = ticket["id"]
    if not isinstance(ticket_id, int) or isinstance(ticket_id, bool) or ticket_id <= 0:
        return [f"билет {ticket_id!r}: id должен быть положительным целым"]

    if not ticket["question"]:
        errors.append(f"билет {ticket_id}: пустой текст вопроса")

    answers = ticket["answers"]
    if len(answers) < MIN_ANSWERS:
        errors.append(f"билет {ticket_id}: меньше {MIN_ANSWERS} ответов")
    if any(not answer for answer in answers):
        errors.append(f"билет {ticket_id}: есть пустой ответ")

    correct = ticket["correct"]
    is_int = isinstance(correct, int) and not isinstance(correct, bool)
    if not is_int or not 0 <= correct < len(answers):
        errors.append(f"билет {ticket_id}: правильный ответ не определён ({correct!r})")

    # image_url есть, а локального файла нет — картинку потеряли, база неполная.
    if ticket["image_url"] and not ticket["image"]:
        errors.append(f"билет {ticket_id}: картинка есть у источника, но не скачана")

    return errors


def validate(tickets, total, pages_seen, page_count):
    """Проверить собранную базу. Возвращает список сообщений об ошибках.

    pages_seen — {номер страницы: сколько билетов с неё разобрано}.
    """
    errors = []

    if len(tickets) != total:
        errors.append(
            f"разобрано {len(tickets)} билетов, источник заявляет {total}"
        )

    missing_pages = [n for n in range(1, page_count + 1) if n not in pages_seen]
    if missing_pages:
        errors.append(f"не обработаны страниц: {missing_pages}")

    empty_pages = [n for n, count in sorted(pages_seen.items()) if count == 0]
    if empty_pages:
        errors.append(f"пустые страницы (ноль билетов): {empty_pages}")

    seen_ids = set()
    duplicates = set()
    for ticket in tickets:
        ticket_id = ticket["id"]
        if ticket_id in seen_ids:
            duplicates.add(ticket_id)
        seen_ids.add(ticket_id)
        errors.extend(_validate_ticket(ticket))

    if duplicates:
        errors.append(f"дублирующиеся id: {sorted(duplicates)}")

    return errors
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 28 passed

- [ ] **Step 5: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: валидация базы билетов — id, ответы, правильный, страницы, картинки"
```

---

### Task 6: Кэш страниц

Кэш разложен по категории и языку: `tools/.cache/category-2/ru/page-N.html`. Перед использованием файл проверяется — иначе русский запуск подцепит старый грузинский кэш и почти все проверки пройдут успешно. Запись атомарная.

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
def test_is_page_html_valid_accepts_ru_page(html_ru):
    assert pt.is_page_html_valid(html_ru) is True


def test_is_page_html_valid_rejects_other_locale(html_ka):
    assert pt.is_page_html_valid(html_ka) is False


def test_is_page_html_valid_rejects_empty():
    assert pt.is_page_html_valid("") is False


def test_is_page_html_valid_rejects_other_category(html_ru):
    assert pt.is_page_html_valid(html_ru.replace('/tickets/2', '/tickets/5')) is False


def test_cache_roundtrip(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    assert pt.read_cached_page(3) is None
    pt.write_cached_page(3, html_ru)
    assert pt.read_cached_page(3) == html_ru


def test_read_cached_page_rejects_wrong_locale(tmp_path, monkeypatch, html_ka):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    (tmp_path / "page-1.html").write_text(html_ka, encoding="utf-8")
    assert pt.read_cached_page(1) is None


def test_read_cached_page_rejects_empty_file(tmp_path, monkeypatch):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    (tmp_path / "page-1.html").write_text("", encoding="utf-8")
    assert pt.read_cached_page(1) is None


def test_write_cached_page_leaves_no_temp_files(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    pt.write_cached_page(1, html_ru)
    assert [p.name for p in tmp_path.iterdir()] == ["page-1.html"]
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k "cache or page_html" -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'is_page_html_valid'`

- [ ] **Step 3: Написать реализацию**

Добавить импорты вверху `tools/parse_tickets.py`:
```python
import os
from pathlib import Path
```

Добавить константы после `LIST_URL`:
```python
TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = TOOLS_DIR.parent
DATA_DIR = ROOT_DIR / "data"
IMAGES_DIR = DATA_DIR / "tickets" / "images"
OUTPUT_JSON = DATA_DIR / f"tickets-{CATEGORY_LABELS[0].lower()}-{LOCALE}.json"
CACHE_DIR = TOOLS_DIR / ".cache" / f"category-{CATEGORY_ID}" / LOCALE

# Признаки того, что страница отдана в нужном языке и нужной категории.
LOCALE_MARKER = f"locale-{LOCALE}"
CATEGORY_MARKER = f'data-active="/tickets/{CATEGORY_ID}"'
```

И функции:
```python
def is_page_html_valid(html):
    """Страница непустая, отдана в нужной локали и относится к нужной категории."""
    if not html or not html.strip():
        return False
    return LOCALE_MARKER in html and CATEGORY_MARKER in html


def _cache_path(page):
    return CACHE_DIR / f"page-{page}.html"


def read_cached_page(page):
    """HTML из кэша, либо None, если кэша нет или он негодный."""
    path = _cache_path(page)
    if not path.exists():
        return None
    html = path.read_text(encoding="utf-8")
    return html if is_page_html_valid(html) else None


def write_cached_page(page, html):
    """Записать страницу в кэш атомарно — оборванная запись не оставит битый файл."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(page)
    tmp = path.with_suffix(".html.tmp")
    tmp.write_text(html, encoding="utf-8")
    os.replace(tmp, path)
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 36 passed

- [ ] **Step 5: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: кэш страниц с разделением по категории и языку"
```

---

### Task 7: Проверка и скачивание картинок

«Файл больше нуля байт» ничего не доказывает: заглушка Cloudflare тоже весит больше нуля, а у обрезанного JPEG магические байты в порядке. Поэтому проверяем декодированием через Pillow: `verify()` ловит битую структуру, `load()` — недокачанный файл.

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tools/tests/test_parse_tickets.py` (импорт `io` и `PIL` — вверх файла, к остальным импортам):
```python
def _write_png(path, size=(8, 8)):
    from PIL import Image

    Image.new("RGB", size, (10, 120, 200)).save(path, format="PNG")


def _write_jpeg_bytes(size=(64, 64)):
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 60, 10)).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_verify_image_accepts_real_png(tmp_path):
    path = tmp_path / "good.png"
    _write_png(path)
    assert pt.verify_image(path) is True


def test_verify_image_rejects_html_with_jpg_extension(tmp_path):
    path = tmp_path / "cloudflare.jpg"
    path.write_text("<html><body>Attention Required! | Cloudflare</body></html>", encoding="utf-8")
    assert pt.verify_image(path) is False


def test_verify_image_rejects_truncated_jpeg(tmp_path):
    data = _write_jpeg_bytes()
    path = tmp_path / "truncated.jpg"
    path.write_bytes(data[: len(data) // 2])
    # Магические байты у обрезанного файла верные — поймать может только декодирование.
    assert path.read_bytes()[:2] == b"\xff\xd8"
    assert pt.verify_image(path) is False


def test_verify_image_rejects_missing_file(tmp_path):
    assert pt.verify_image(tmp_path / "нет-такого.jpg") is False
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k verify_image -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'verify_image'`

- [ ] **Step 3: Реализовать verify_image**

Добавить импорт вверху `tools/parse_tickets.py`:
```python
from PIL import Image
```

И функцию:
```python
def verify_image(path):
    """Файл действительно декодируется как изображение.

    verify() ловит битую структуру, но не всегда — обрыв файла, поэтому следом
    открываем заново и делаем load(): у недокачанного JPEG заголовок цел,
    а данные — нет.
    """
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
        return True
    except Exception:
        return False
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k verify_image -v
```
Ожидаемо: 4 passed

- [ ] **Step 5: Написать падающие тесты для download_image**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
class FakeResponse:
    def __init__(self, content, content_type="image/jpeg", status=200):
        self.content = content
        self.headers = {"Content-Type": content_type}
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        return self.response


def test_download_image_saves_valid_image(tmp_path):
    session = FakeSession(FakeResponse(_write_jpeg_bytes()))
    dest = tmp_path / "a.jpg"
    assert pt.download_image(session, "https://example.com/a.jpg", dest) is True
    assert dest.exists()


def test_download_image_rejects_non_image_content_type(tmp_path):
    session = FakeSession(FakeResponse(b"<html>error</html>", content_type="text/html"))
    dest = tmp_path / "b.jpg"
    assert pt.download_image(session, "https://example.com/b.jpg", dest) is False
    assert not dest.exists()


def test_download_image_rejects_corrupt_body_and_removes_file(tmp_path):
    session = FakeSession(FakeResponse(b"not an image at all", content_type="image/jpeg"))
    dest = tmp_path / "c.jpg"
    assert pt.download_image(session, "https://example.com/c.jpg", dest) is False
    assert not dest.exists()


def test_download_image_skips_existing_valid_file(tmp_path):
    dest = tmp_path / "d.png"
    _write_png(dest)
    session = FakeSession(FakeResponse(b"", content_type="image/jpeg"))
    assert pt.download_image(session, "https://example.com/d.png", dest) is True
    assert session.calls == 0


def test_download_image_redownloads_existing_broken_file(tmp_path):
    dest = tmp_path / "e.jpg"
    dest.write_text("<html>мусор с прошлого запуска</html>", encoding="utf-8")
    session = FakeSession(FakeResponse(_write_jpeg_bytes()))
    assert pt.download_image(session, "https://example.com/e.jpg", dest) is True
    assert session.calls == 1
    assert pt.verify_image(dest) is True
```

- [ ] **Step 6: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k download_image -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'download_image'`

- [ ] **Step 7: Реализовать download_image**

Добавить константу к остальным:
```python
REQUEST_TIMEOUT_SEC = 30
```

И функцию:
```python
def download_image(session, url, dest):
    """Скачать картинку в dest. True — на диске лежит проверенное изображение.

    Уже лежащий файл повторно не качаем, но проверяем: Content-Type для него
    взять неоткуда, поэтому единственная проверка — декодирование.
    """
    if dest.exists():
        if verify_image(dest):
            return True
        dest.unlink()  # мусор с прошлого запуска — качаем заново

    try:
        response = session.get(url, timeout=REQUEST_TIMEOUT_SEC)
        response.raise_for_status()
    except Exception:
        return False

    content_type = response.headers.get("Content-Type", "")
    if not content_type.startswith("image/"):
        return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(response.content)
    if not verify_image(tmp):
        tmp.unlink()
        return False

    os.replace(tmp, dest)
    return True
```

- [ ] **Step 8: Запустить все тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 45 passed

- [ ] **Step 9: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: скачивание картинок с проверкой Content-Type и декодированием"
```

---

### Task 8: Загрузка страниц с ретраями

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
class FlakySession:
    """Отдаёт ошибку первые fail_times вызовов, потом — страницу."""

    def __init__(self, html, fail_times=0):
        self.html = html
        self.fail_times = fail_times
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("сеть отвалилась")
        return FakeResponse(self.html.encode("utf-8"), content_type="text/html")


def test_fetch_page_uses_cache_without_network(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    pt.write_cached_page(1, html_ru)
    session = FlakySession(html_ru)
    assert pt.fetch_page(session, 1) == html_ru
    assert session.calls == 0


def test_fetch_page_downloads_and_caches(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    session = FlakySession(html_ru)
    assert pt.fetch_page(session, 2) == html_ru
    assert session.calls == 1
    assert pt.read_cached_page(2) == html_ru


def test_fetch_page_ignores_cache_with_refresh(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    pt.write_cached_page(1, html_ru)
    session = FlakySession(html_ru)
    pt.fetch_page(session, 1, refresh=True)
    assert session.calls == 1


def test_fetch_page_retries_then_succeeds(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    session = FlakySession(html_ru, fail_times=2)
    assert pt.fetch_page(session, 1) == html_ru
    assert session.calls == 3


def test_fetch_page_raises_after_all_retries(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    session = FlakySession(html_ru, fail_times=99)
    with pytest.raises(RuntimeError, match="страниц"):
        pt.fetch_page(session, 4)


def test_fetch_page_rejects_wrong_locale_response(tmp_path, monkeypatch, html_ka):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    session = FlakySession(html_ka)
    with pytest.raises(RuntimeError, match="локал"):
        pt.fetch_page(session, 1)


def test_build_session_sets_locale_cookie():
    session = pt.build_session()
    assert "%22locale%22%3A%22ru%22" in session.headers["Cookie"]
    assert "autoshkola.ge" in session.headers["User-Agent"]
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k "fetch_page or build_session" -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'fetch_page'`

- [ ] **Step 3: Написать реализацию**

Добавить импорты вверху `tools/parse_tickets.py`:
```python
import json
import time
from urllib.parse import quote

import requests
```

Добавить константы:
```python
PAGE_DELAY_SEC = 0.7
HTTP_RETRIES = 3
RETRY_BACKOFF_SEC = 2
USER_AGENT = "autoshkola.ge tickets parser (+https://avtoshkola.ge)"
```

И функции:
```python
def build_session():
    """HTTP-сессия с cookie нужного языка.

    Источник переключает язык только на полный объект настроек: неполный
    (без category/skin/user) локаль не меняет — проверено вручную.
    """
    settings = {"category": CATEGORY_ID, "locale": LOCALE, "skin": "dark", "user": 0}
    cookie_value = quote(json.dumps(settings, separators=(",", ":")), safe="")
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Cookie": f"exam-settings={cookie_value}",
        }
    )
    return session


def fetch_page(session, page, refresh=False):
    """HTML страницы списка: из кэша, либо из сети с ретраями.

    Ответ в чужой локали/категории — это ошибка, а не повод писать его в кэш.
    """
    if not refresh:
        cached = read_cached_page(page)
        if cached is not None:
            return cached

    last_error = None
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            response = session.get(
                LIST_URL, params={"page": page}, timeout=REQUEST_TIMEOUT_SEC
            )
            response.raise_for_status()
            html = response.content.decode("utf-8", errors="replace")
            if not is_page_html_valid(html):
                raise RuntimeError(
                    f"страница {page}: ответ не в локали {LOCALE} "
                    f"или не категория {CATEGORY_ID}"
                )
            write_cached_page(page, html)
            time.sleep(PAGE_DELAY_SEC)
            return html
        except RuntimeError:
            raise
        except Exception as error:
            last_error = error
            time.sleep(RETRY_BACKOFF_SEC * attempt)

    raise RuntimeError(f"страница {page}: не удалось скачать за {HTTP_RETRIES} попыток ({last_error})")
```

- [ ] **Step 4: Запустить все тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 52 passed

- [ ] **Step 5: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: загрузка страниц с ретраями, cookie локали и проверкой ответа"
```

---

### Task 9: Сборка базы и запись результата

Порядок принципиален: собрали → проверили → и только потом записали. Иначе провалившийся прогон оставит на диске плохую базу.

**Files:**
- Modify: `tools/parse_tickets.py`
- Test: `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tools/tests/test_parse_tickets.py`:
```python
def test_build_document_sorts_by_id_and_fills_meta():
    tickets = [make_ticket(id=9), make_ticket(id=2)]
    document = pt.build_document(tickets, total=2)
    assert [t["id"] for t in document["tickets"]] == [2, 9]
    assert document["meta"]["category_id"] == 2
    assert document["meta"]["categories"] == ["B", "B1"]
    assert document["meta"]["lang"] == "ru"
    assert document["meta"]["total"] == 2
    assert document["meta"]["parsed_at"].startswith("20")


def test_build_document_drops_internal_image_url_field():
    tickets = [make_ticket(image_url="https://example.com/a.jpg", image="tickets/images/a.jpg")]
    document = pt.build_document(tickets, total=1)
    assert "image_url" not in document["tickets"][0]
    assert document["tickets"][0]["image"] == "tickets/images/a.jpg"


def test_write_output_creates_file(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    pt.write_output({"meta": {"total": 1}, "tickets": [make_ticket()]})
    import json as json_module

    written = json_module.loads(target.read_text(encoding="utf-8"))
    assert written["tickets"][0]["question"] == "Вопрос"


def test_write_output_replaces_atomically_without_temp_leftovers(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    target.write_text('{"старое": true}', encoding="utf-8")
    pt.write_output({"meta": {}, "tickets": []})
    assert [p.name for p in tmp_path.iterdir()] == ["tickets-b-ru.json"]
    assert "старое" not in target.read_text(encoding="utf-8")
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -k "build_document or write_output" -v
```
Ожидаемо: FAIL — `AttributeError: module 'tools.parse_tickets' has no attribute 'build_document'`

- [ ] **Step 3: Реализовать сборку и запись**

Добавить импорты вверху `tools/parse_tickets.py`:
```python
import argparse
import sys
from datetime import datetime
from urllib.parse import urlparse
```
(`urlparse` нужен в `collect()` ниже — для имени файла картинки.)

И функции:
```python
TICKET_FIELDS = ("id", "question", "image", "answers", "correct", "source")


def build_document(tickets, total):
    """Итоговый JSON-документ: meta + билеты, отсортированные по id.

    Порядок стабильный, чтобы diff в git был читаемым. Побайтово файл между
    прогонами не совпадёт — parsed_at меняется.
    """
    return {
        "meta": {
            "category_id": CATEGORY_ID,
            "categories": CATEGORY_LABELS,
            "lang": LOCALE,
            "source": LIST_URL,
            "parsed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "total": total,
        },
        "tickets": [
            {field: ticket.get(field) for field in TICKET_FIELDS}
            for ticket in sorted(tickets, key=lambda t: t["id"])
        ],
    }


def write_output(document):
    """Атомарно записать JSON: провалившаяся запись не портит прошлый результат."""
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT_JSON.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, OUTPUT_JSON)
```

- [ ] **Step 4: Запустить тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 56 passed

- [ ] **Step 5: Написать main()**

Добавить в конец `tools/parse_tickets.py`:
```python
def collect(session, refresh=False):
    """Обойти все страницы, скачать картинки.

    Возвращает (билеты, total, pages_seen, page_count). page_count возвращаем явно:
    выводить его из pages_seen нельзя — тогда пропущенная страница сама себя спрячет.
    """
    first_page = fetch_page(session, 1, refresh=refresh)
    total = parse_total(first_page)
    page_count = parse_page_count(first_page)
    print(f"Источник заявляет: {total} билетов, {page_count} страниц")

    tickets = []
    pages_seen = {}
    for page in range(1, page_count + 1):
        html = first_page if page == 1 else fetch_page(session, page, refresh=refresh)
        page_tickets = parse_tickets(html, f"{LIST_URL}?page={page}")
        pages_seen[page] = len(page_tickets)
        tickets.extend(page_tickets)
        print(f"  страница {page}/{page_count}: {len(page_tickets)} билетов")

    for ticket in tickets:
        ticket["image"] = None
        if not ticket["image_url"]:
            continue
        # Имя берём из пути URL, а не из хвоста строки: query-параметр
        # превратился бы в часть имени файла.
        filename = Path(urlparse(ticket["image_url"]).path).name
        dest = IMAGES_DIR / filename
        if download_image(session, ticket["image_url"], dest):
            ticket["image"] = str(dest.relative_to(DATA_DIR))
        else:
            print(f"  ! билет {ticket['id']}: картинка не скачалась ({ticket['image_url']})")

    return tickets, total, pages_seen, page_count


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Парсер билетов ПДД Грузии (категория B/B1, русский)"
    )
    parser.add_argument(
        "--refresh", action="store_true", help="игнорировать кэш и перекачать страницы"
    )
    args = parser.parse_args(argv)

    session = build_session()
    tickets, total, pages_seen, page_count = collect(session, refresh=args.refresh)

    errors = validate(tickets, total, pages_seen, page_count)
    if errors:
        print(f"\nБаза невалидна, найдено проблем: {len(errors)}", file=sys.stderr)
        for error in errors[:50]:
            print(f"  - {error}", file=sys.stderr)
        if len(errors) > 50:
            print(f"  ... и ещё {len(errors) - 50}", file=sys.stderr)
        print(f"\n{OUTPUT_JSON} НЕ перезаписан.", file=sys.stderr)
        return 1

    write_output(build_document(tickets, total))
    with_images = sum(1 for t in tickets if t["image"])
    print(f"\nГотово: {len(tickets)} билетов ({with_images} с картинками) → {OUTPUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Проверить, что скрипт запускается и показывает справку**

```bash
.venv/bin/python -m tools.parse_tickets --help
```
Ожидаемо: справка с флагом `--refresh`, без трейсбэка

- [ ] **Step 7: Прогнать все тесты**

```bash
.venv/bin/python -m pytest tools/tests/test_parse_tickets.py -v
```
Ожидаемо: 56 passed

- [ ] **Step 8: Commit**

```bash
git add tools/parse_tickets.py tools/tests/test_parse_tickets.py
git commit -m "feat: сборка базы, атомарная запись JSON после валидации, CLI"
```

---

### Task 10: Реальный прогон и коммит базы

- [ ] **Step 1: Запустить парсер**

```bash
.venv/bin/python -m tools.parse_tickets
```
Ожидаемо: 47 строк прогресса, в конце `Готово: 921 билетов (N с картинками) → .../data/tickets-b-ru.json`, код возврата 0.
Прогон занимает несколько минут (пауза 0.7 с между страницами + скачивание картинок).

Если код возврата 1 — читать список проблем, чинить разбор, повторять. JSON при этом не записан, старая база цела.

- [ ] **Step 2: Проверить результат независимо от скрипта**

```bash
.venv/bin/python - <<'EOF'
import json, pathlib
d = json.loads(pathlib.Path("data/tickets-b-ru.json").read_text(encoding="utf-8"))
t = d["tickets"]
print("билетов:", len(t), "| meta.total:", d["meta"]["total"])
print("уникальных id:", len({x["id"] for x in t}))
print("с картинками:", sum(1 for x in t if x["image"]))
print("файлов картинок:", len(list(pathlib.Path("data/tickets/images").glob("*"))))
print("ответов минимум:", min(len(x["answers"]) for x in t))
print("correct вне диапазона:", [x["id"] for x in t if not 0 <= x["correct"] < len(x["answers"])])
print("пример:", json.dumps(t[0], ensure_ascii=False)[:200])
EOF
```
Ожидаемо: билетов 921, уникальных id 921, `correct вне диапазона: []`, минимум ответов ≥ 2, число файлов картинок не меньше числа билетов с картинками (файлы переиспользуются между билетами).

- [ ] **Step 3: Проверить, что временные файлы не остались**

```bash
find data tools -name "*.tmp" | head
git status --short | head -20
```
Ожидаемо: ни одного `.tmp`; в `git status` только `data/`, `tools/.cache/` не показан (в .gitignore)

- [ ] **Step 4: Убедиться, что сайт не тронут**

```bash
git status --short index.html css js
```
Ожидаемо: пусто

- [ ] **Step 5: Посмотреть, сколько весит база**

```bash
du -sh data/tickets/images data/tickets-b-ru.json
```
Записать цифры — пригодятся при решении, как отдавать базу на сайте.

- [ ] **Step 6: Commit**

```bash
git add data
git commit -m "feat: база билетов ПДД категории B на русском — 921 билет с картинками"
```

- [ ] **Step 7: Обновить README**

Дописать в `README.md` перед разделом «Запуск локально»:
```markdown
## База билетов ПДД

`data/tickets-b-ru.json` — 921 экзаменационный билет категории B/B1 на русском,
картинки в `data/tickets/images/`. Собирается парсером:

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements-dev.txt
.venv/bin/python -m tools.parse_tickets
```

Страницы кэшируются в `tools/.cache/` — повторный запуск не дёргает источник заново,
`--refresh` кэш игнорирует. Скрипт перезаписывает JSON только если база прошла проверки.

Источник — [teoria.on.ge](https://teoria.on.ge). Вопросы взяты из официального экзамена
МВД Грузии, русский перевод и картинки — работа on.ge. **Перед публикацией раздела
на сайте проверить условия использования и при необходимости запросить разрешение.**
```

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: README — как собрать базу билетов"
```

---

## Итог

После Task 10 в ветке `dev`:
- `data/tickets-b-ru.json` — 921 билет, отсортированы по id
- `data/tickets/images/` — картинки, проверенные декодированием
- `tools/parse_tickets.py` + 56 тестов, сеть в тестах не нужна
- `index.html`, css, js не изменены, `main` не тронут

Следующий этап (отдельный спек): раздел-тренажёр на сайте.
