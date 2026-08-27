# Изъятые билеты — план

**Goal:** Тренажёр не показывает 26 билетов, изъятых из официального банка вопросов; база продолжает честно отражать источник, но помечает такие билеты.

**Принцип:** парсер остаётся слепком teoria.on.ge — билеты не удаляются, а помечаются. Список изъятых ведётся отдельно, руками, в `data/withdrawn-tickets.json`, и накладывается на базу при разборе. Так повторный запуск парсера не теряет пометки.

---

### Task 1: Парсер помечает изъятые билеты

**Files:** Modify `tools/parse_tickets.py`, `tools/tests/test_parse_tickets.py`

- [ ] **Step 1: Тесты**

```python
def test_load_withdrawn_ids_reads_file(tmp_path, monkeypatch):
    path = tmp_path / "withdrawn.json"
    path.write_text('{"meta": {}, "tickets": [{"id": 5}, {"id": 9}]}', encoding="utf-8")
    monkeypatch.setattr(pt, "WITHDRAWN_JSON", path)
    assert pt.load_withdrawn_ids() == {5, 9}


def test_load_withdrawn_ids_without_file(tmp_path, monkeypatch):
    monkeypatch.setattr(pt, "WITHDRAWN_JSON", tmp_path / "нет.json")
    assert pt.load_withdrawn_ids() == set()


def test_mark_withdrawn_sets_flag():
    tickets = [make_ticket(id=1), make_ticket(id=5)]
    marked = pt.mark_withdrawn(tickets, {5})
    assert marked[0]["withdrawn"] is False
    assert marked[1]["withdrawn"] is True


def test_mark_withdrawn_does_not_mutate_input():
    tickets = [make_ticket(id=5)]
    pt.mark_withdrawn(tickets, {5})
    assert "withdrawn" not in tickets[0]


def test_validate_catches_unknown_withdrawn_id():
    tickets = [make_ticket(id=1, withdrawn=False)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1, withdrawn_ids={42})
    assert any("42" in e for e in errors)
```

- [ ] **Step 2: Убедиться, что падают**

- [ ] **Step 3: Реализация**

Константа рядом с остальными путями:
```python
WITHDRAWN_JSON = DATA_DIR / "withdrawn-tickets.json"
```

Функции:
```python
def load_withdrawn_ids():
    """id билетов, изъятых из официального банка вопросов.

    Список ведётся руками в data/withdrawn-tickets.json: у источника пометки нет,
    он держит изъятые билеты в общем списке.
    """
    if not WITHDRAWN_JSON.exists():
        return set()
    document = json.loads(WITHDRAWN_JSON.read_text(encoding="utf-8"))
    return {int(item["id"]) for item in document.get("tickets", [])}


def mark_withdrawn(tickets, withdrawn_ids):
    """Проставить признак изъятия, не меняя исходные словари."""
    return [{**ticket, "withdrawn": ticket["id"] in withdrawn_ids} for ticket in tickets]
```

В `validate` добавить необязательный параметр и проверку:
```python
def validate(tickets, total, pages_seen, page_count, withdrawn_ids=frozenset()):
    ...
    known_ids = {ticket["id"] for ticket in tickets}
    unknown = sorted(set(withdrawn_ids) - known_ids)
    if unknown:
        errors.append(f"в списке изъятых есть id, которых нет в базе: {unknown}")
```
Смысл проверки: если источник переименует или удалит билет, список изъятых протухнет молча — а так прогон честно упадёт.

В `collect` после разбора билетов: `tickets = mark_withdrawn(tickets, load_withdrawn_ids())`.
В `TICKET_FIELDS` добавить `"withdrawn"` после `"lang"`.
В `main` передать `withdrawn_ids` в `validate`.

- [ ] **Step 4: Тесты зелёные, перегенерировать базу**

```bash
.venv/bin/python -m pytest tools/tests/ -q
.venv/bin/python -m tools.parse_tickets
```
Ожидаемо: 921 билет, у 26 из них `withdrawn: true`.

- [ ] **Step 5: Commit**

---

### Task 2: Тренажёр и экзамен не показывают изъятые

**Files:** Modify `js/exam-logic.js`, `js/training-logic.js`, тесты обоих

- [ ] **Step 1: Тесты**

В `js/tests/exam-logic.test.js`:
```js
test("изъятые билеты в экзамен не попадают", () => {
  const pool = [
    ...makeTickets(40, "ru"),
    ...makeTickets(40, "ru").map((t) => ({ ...t, id: t.id + 100, withdrawn: true })),
  ];
  const picked = selectExamTickets(pool);
  assert.ok(picked.every((t) => !t.withdrawn));
});
```

В `js/tests/training-logic.test.js`:
```js
test("изъятые билеты не попадают ни в один фильтр", () => {
  const pool = [
    { id: 1, lang: "ru" },
    { id: 2, lang: "ru", withdrawn: true },
  ];
  for (const filter of Object.values(FILTERS)) {
    const list = filterTickets(pool, { solved: [2], mistakes: [2], position: 0 }, filter);
    assert.ok(list.every((t) => !t.withdrawn));
  }
});
```

- [ ] **Step 2: Убедиться, что падают**

- [ ] **Step 3: Реализация**

В `js/exam-logic.js`, в `selectExamTickets`:
```js
  // Изъятые из официального банка вопросы ученику показывать незачем.
  const pool = tickets.filter((ticket) => ticket.lang === "ru" && !ticket.withdrawn);
```

В `js/training-logic.js`, в `filterTickets`:
```js
  const ru = tickets.filter((ticket) => ticket.lang === "ru" && !ticket.withdrawn);
```

- [ ] **Step 4: Тесты зелёные**

- [ ] **Step 5: Самопроверка мутацией** — убрать `&& !ticket.withdrawn` в каждом файле, убедиться что падает свой тест.

- [ ] **Step 6: Commit**

---

### Task 3: Тексты

**Files:** `index.html`, `bilety/index.html`, `bilety/trenirovka/index.html`, `README.md`, `docs/tickets-known-issues.md`

- [ ] Заменить «в базе 921 вопрос» на официальные 898 — и в тексте вопроса-ответа, и в разметке для поисковиков.
- [ ] На страницах тренажёра заменить упоминания 870 на действующее число.
- [ ] В `docs/tickets-known-issues.md` добавить раздел про изъятые билеты со ссылкой на `data/withdrawn-tickets.json`.
- [ ] Commit.

---

## Итог

Официальный банк — 898 вопросов: 847 на русском и 51 в теме «эко-вождение» только на грузинском.
В тренажёре 844 билета: 870 русских минус 26 помеченных изъятыми (21 опознан точно, 5 спорных убраны с запасом).
