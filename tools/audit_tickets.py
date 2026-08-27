"""Сверка базы билетов ПДД (data/tickets-b-ru.json) с официальным PDF-сборником.

RU-B.pdf сгенерирован источником 22.12.2014 и парсится независимо от
tools/parse_tickets.py — это отдельный угол проверки «A» из плана аудита
(docs/superpowers/plans/2026-08-27-tickets-audit.md, Task 1). PDF от 2014
года, поэтому расхождение с базой — не автоматически «ошибка в базе»: билет
могли отредактировать позже. Сопоставление билетов идёт не по номеру (за 11
лет нумерация могла измениться), а по нормализованному тексту вопроса вместе
с набором ответов.

Использование:
    .venv/bin/python -m tools.audit_tickets --pdf RU-B.pdf --check-parse
    .venv/bin/python -m tools.audit_tickets --pdf RU-B.pdf --report
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = TOOLS_DIR.parent
DEFAULT_TICKETS_JSON = ROOT_DIR / "data" / "tickets-b-ru.json"

# --- Структура страницы PDF (проверено вручную на страницах 3-4 RU-B.pdf) ---
# Заголовок вопроса: "ВОПРОС N" и "ПРАВИЛЬНЫЙ ОТВЕТ: K", K считается с единицы.
HEADER_RE = re.compile(r"ВОПРОС\s+(\d+)\s*ПРАВИЛЬНЫЙ ОТВЕТ:\s*(\d+)")
# Пояснение к билету идёт по-грузински и начинается с "განმართება" — отбрасываем.
GEORGIAN_RE = re.compile(r"[Ⴀ-ჿ]")
# Колонки с номерами ответов ("1"/"2" в одной строке, "3"/"4" в другой).
NUMBER_COLUMNS_X = (47.6, 321.2)
# Колонки с текстом самих ответов.
ANSWER_COLUMNS_X = (73.2, 346.8)
# Реальные координаты колонок в PDF фиксированы с точностью до сотых (проверено
# на всём документе). Допуск взят с запасом, но небольшим: более широкий (например,
# ±5) иногда захватывал первую строку вопроса, если она рендерилась близко к
# левой колонке ответов (x0=69.6 при колонке 73.2) — вопрос терялся, а его текст
# попадал в список ответов лишним пунктом.
COLUMN_TOLERANCE = 1.0
# Разрыв по Y между строками ОДНОГО ответа при переносе текста (~2.3pt на
# практике). Между двумя РАЗНЫМИ ответами в одной колонке разрыв на порядок
# больше (от ~27pt) — граница выбрана с большим запасом.
WRAP_GAP_MAX = 10.0
# Изредка первая строка вопроса рендерится с тем же x0, что и левая колонка
# ответов (x0=72.66 при колонке 73.2) — координата её не отличает. Отличает
# ширина строки: настоящий ответ в колонке никогда не бывает шире ~212pt (иначе
# он бы наехал на вторую колонку или на край страницы), а строка вопроса —
# полноширинная (от ~448pt). Граница взята с большим запасом между ними.
MAX_ANSWER_LINE_WIDTH = 300.0


def _is_near(x0, target, tol=COLUMN_TOLERANCE):
    return abs(x0 - target) <= tol


def _clean(text):
    """Схлопнуть переносы строк и неразрывные пробелы блока в одну строку."""
    return " ".join(text.replace("\xa0", " ").split())


def _is_number_label(x0, text):
    """Блок — просто номер ответа (например «1» или «1 2»), а не текст ответа."""
    digits_only = "".join(text.split())
    return digits_only.isdigit() and any(_is_near(x0, c) for c in NUMBER_COLUMNS_X)


def parse_pdf_blocks(blocks):
    """Разобрать блоки ОДНОЙ страницы PDF в список вопросов.

    blocks — список (x0, y0, текст) в порядке из page.get_text("blocks")
    (или их логический эквивалент — см. extract_page_blocks). Правила разбора:
    заголовок открывает вопрос, блоки до следующего заголовка — его тело;
    ответы — блоки в колонках ANSWER_COLUMNS_X, порядок — сортировка по (y, x);
    вопрос — оставшиеся кириллические блоки; грузинские и блоки-номера отбрасываются.
    """
    headers = []
    for x0, y0, text in blocks:
        match = HEADER_RE.search(text)
        if match:
            headers.append((y0, int(match.group(1)), int(match.group(2))))
    headers.sort(key=lambda h: h[0])

    questions = []
    for idx, (header_y, number, correct_raw) in enumerate(headers):
        next_y = headers[idx + 1][0] if idx + 1 < len(headers) else float("inf")
        body = [
            (x0, y0, text)
            for x0, y0, text in blocks
            if header_y <= y0 < next_y and not HEADER_RE.search(text)
        ]

        answer_parts = []
        question_parts = []
        for x0, y0, text in body:
            if GEORGIAN_RE.search(text):
                continue  # пояснение по-грузински — не участвует в сверке
            if _is_number_label(x0, text):
                continue  # номер ответа в отдельной колонке
            if any(_is_near(x0, c) for c in ANSWER_COLUMNS_X):
                answer_parts.append((y0, x0, _clean(text)))
            else:
                question_parts.append((y0, x0, _clean(text)))

        answer_parts.sort(key=lambda a: (a[0], a[1]))
        question_parts.sort(key=lambda q: (q[0], q[1]))

        questions.append(
            {
                "number": number,
                "correct": correct_raw - 1,  # PDF нумерует с 1, у нас с нуля
                "question": " ".join(p[2] for p in question_parts),
                "answers": [a[2] for a in answer_parts],
            }
        )
    return questions


def _merge_wrapped_lines(lines):
    """Склеить перенесённые строки одного ответа в одну логическую запись.

    lines — список (x0, y0, y1, текст) ОДНОЙ колонки, отсортированный по y0.
    Строки, идущие подряд с маленьким разрывом по Y (перенос текста одного
    ответа), объединяются; больший разрыв означает, что начался другой ответ.
    Возвращает список (x0, y0, текст).
    """
    merged = []
    prev_y1 = None
    for x0, y0, y1, text in lines:
        if merged and prev_y1 is not None and (y0 - prev_y1) <= WRAP_GAP_MAX:
            last_x0, last_y0, last_text = merged[-1]
            merged[-1] = (last_x0, last_y0, last_text + " " + text)
        else:
            merged.append((x0, y0, text))
        prev_y1 = y1
    return merged


def extract_page_blocks(page):
    """Логические блоки страницы для parse_pdf_blocks, извлечённые из pymupdf-страницы.

    Заголовок вопроса берём из page.get_text("blocks"): там оба фрагмента
    заголовка («ВОПРОС N» и «ПРАВИЛЬНЫЙ ОТВЕТ: K») попадают в один блок.
    Остальное берём построчно из page.get_text("dict"): в режиме "blocks"
    pymupdf иногда склеивает в ОДИН блок два однострочных ответа из РАЗНЫХ
    колонок на одной высоте (найдено на билете «Обязан / Не обязан», RU-B.pdf,
    стр. 4) — тогда вторая колонка ответа терялась бы. Перенос текста одного
    ответа на несколько строк склеиваем сами через _merge_wrapped_lines.
    """
    header_blocks = [
        (b[0], b[1], b[4]) for b in page.get_text("blocks") if HEADER_RE.search(b[4])
    ]

    other_lines = []
    col_lines = {column: [] for column in ANSWER_COLUMNS_X}
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = "".join(span["text"] for span in line["spans"])
            if not text.strip() or "ВОПРОС" in text or "ПРАВИЛЬНЫЙ ОТВЕТ" in text:
                continue  # заголовок уже взят из блочного режима
            x0, y0, x1, y1 = line["bbox"]
            column = next((c for c in ANSWER_COLUMNS_X if _is_near(x0, c)), None)
            is_too_wide = (x1 - x0) > MAX_ANSWER_LINE_WIDTH
            if column is not None and not is_too_wide:
                col_lines[column].append((x0, y0, y1, text))
            else:
                if column is not None:
                    # Ширина выдаёт, что это вопрос, а не ответ (см. MAX_ANSWER_LINE_WIDTH):
                    # x0 переносим на нейтральное значение, иначе parse_pdf_blocks
                    # заново примет эту строку за колонку ответов по одной лишь позиции.
                    x0 = 200.0
                other_lines.append((x0, y0, text))

    result = list(header_blocks) + other_lines
    for lines in col_lines.values():
        lines.sort(key=lambda item: item[1])
        result.extend(_merge_wrapped_lines(lines))
    return result


def parse_pdf(path):
    """Разобрать весь PDF в плоский список вопросов (по всем страницам подряд)."""
    import pymupdf  # тяжёлая зависимость — подключаем только когда реально нужна

    doc = pymupdf.open(path)
    questions = []
    for page_index in range(len(doc)):
        questions.extend(parse_pdf_blocks(extract_page_blocks(doc[page_index])))
    return questions


def check_parse_quality(questions):
    """Оценить качество разбора: сколько вопросов разобрано полностью.

    Полностью разобранный вопрос — есть номер, непустой текст, ≥2 ответа и
    правильный ответ указывает на существующий ответ.
    """
    total = len(questions)

    def has_enough_answers(q):
        return len(q["answers"]) >= 2

    def has_valid_correct(q):
        return has_enough_answers(q) and 0 <= q["correct"] < len(q["answers"])

    with_number = sum(1 for q in questions if isinstance(q["number"], int) and q["number"] > 0)
    with_question = sum(1 for q in questions if q["question"])
    with_enough_answers = sum(1 for q in questions if has_enough_answers(q))
    with_correct = sum(1 for q in questions if has_valid_correct(q))
    fully_ok = sum(
        1
        for q in questions
        if isinstance(q["number"], int)
        and q["number"] > 0
        and q["question"]
        and has_valid_correct(q)
    )

    return {
        "total": total,
        "with_number": with_number,
        "with_question": with_question,
        "with_enough_answers": with_enough_answers,
        "with_correct": with_correct,
        "fully_ok": fully_ok,
    }


# --- Сверка с базой: нормализация текста и сопоставление по вопросу+ответам ---

_QUOTE_MAP = str.maketrans(
    {
        "«": '"',
        "»": '"',
        "“": '"',
        "”": '"',
        "„": '"',
        "‘": "'",
        "’": "'",
        "‚": "'",
        "–": "-",
        "—": "-",
        "−": "-",
    }
)


def normalize_text(text):
    """Нормализовать текст для сравнения между источниками.

    Нижний регистр, схлопнутые пробелы, ё→е, унифицированные кавычки и тире,
    отброшенные концевые знаки препинания (план аудита, Task 1 Step 5).
    """
    text = text.strip().lower().replace("ё", "е")
    text = text.translate(_QUOTE_MAP)
    text = " ".join(text.split())
    return text.rstrip(" .,:;!?\"'»«")


def ticket_key(question, answers):
    """Ключ сопоставления: нормализованный вопрос + набор (не порядок!) ответов.

    Порядок ответов у источников может отличаться, поэтому набор, а не список.
    """
    return (normalize_text(question), frozenset(normalize_text(a) for a in answers))


def build_pdf_index(pdf_questions):
    """Сгруппировать вопросы PDF по ключу (вопрос + набор ответов)."""
    index = defaultdict(list)
    for q in pdf_questions:
        if not q["question"] or len(q["answers"]) < 2:
            continue
        if not (0 <= q["correct"] < len(q["answers"])):
            continue
        index[ticket_key(q["question"], q["answers"])].append(q)
    return index


def compare_with_pdf(tickets, pdf_index):
    """Сравнить билеты базы с независимым PDF. Три корзины — план аудита, Task 1 Step 5.

    Отдельно — билеты, для которых сравнение по тексту в принципе ненадёжно:
    в базе есть группы «тот же вопрос и ответы, но разные картинки» (см. Итог
    шага 0 плана аудита) — правильный ответ там зависит от картинки, а её в
    тексте PDF не видно. Опознаём это двумя способами: несколько билетов базы
    делят один ключ (вопрос+ответы), либо сам PDF даёт под этим ключом
    несколько кандидатов с разным правильным ответом. Такие билеты не попадают
    ни в «тот же ответ», ни в «разный ответ» — сравнивать их по тексту нельзя.
    """
    key_counts = Counter(ticket_key(t["question"], t["answers"]) for t in tickets)

    same, different, not_found, ambiguous = [], [], [], []
    for ticket in tickets:
        key = ticket_key(ticket["question"], ticket["answers"])
        candidates = pdf_index.get(key)
        if not candidates:
            not_found.append(ticket)
            continue

        pdf_correct_texts = {
            normalize_text(c["answers"][c["correct"]]) for c in candidates
        }
        if key_counts[key] > 1 or len(pdf_correct_texts) > 1:
            ambiguous.append(ticket)
            continue

        pdf_q = candidates[0]
        db_correct_text = normalize_text(ticket["answers"][ticket["correct"]])
        pdf_correct_text = normalize_text(pdf_q["answers"][pdf_q["correct"]])
        if db_correct_text == pdf_correct_text:
            same.append(ticket)
        else:
            different.append(
                {
                    "ticket": ticket,
                    "pdf_correct_answer": pdf_q["answers"][pdf_q["correct"]],
                    "pdf_number": pdf_q["number"],
                }
            )
    return same, different, not_found, ambiguous


# --- CLI ---

QUALITY_THRESHOLD = 0.95


def load_tickets(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["tickets"]


def cmd_check_parse(pdf_path):
    """Шаг 4 плана: сначала оценить качество разбора, выводы делать только после."""
    questions = parse_pdf(pdf_path)
    stats = check_parse_quality(questions)
    total = stats["total"]
    ratio = stats["fully_ok"] / total if total else 0.0

    print(f"Вопросов найдено в PDF: {total}")
    for label, key in (
        ("с номером", "with_number"),
        ("с непустым текстом вопроса", "with_question"),
        ("с ≥2 ответами", "with_enough_answers"),
        ("с правильным ответом в допустимом диапазоне", "with_correct"),
    ):
        count = stats[key]
        print(f"  {label}: {count} ({count / total:.1%})" if total else f"  {label}: 0")
    print(f"Полностью разобрано: {stats['fully_ok']} ({ratio:.1%})")

    if ratio < QUALITY_THRESHOLD:
        print(
            f"\nВНИМАНИЕ: доля разобранных вопросов ниже {QUALITY_THRESHOLD:.0%} — "
            "разбор нужно чинить, выводы о расхождениях делать рано.",
            file=sys.stderr,
        )
        return 1
    return 0


def cmd_report(pdf_path, tickets_path):
    """Шаги 5-6 плана: сверка с базой и отчёт по трём корзинам."""
    questions = parse_pdf(pdf_path)
    stats = check_parse_quality(questions)
    ratio = stats["fully_ok"] / stats["total"] if stats["total"] else 0.0
    print(f"Разбор PDF: {stats['fully_ok']}/{stats['total']} вопросов ({ratio:.1%})")

    if ratio < QUALITY_THRESHOLD:
        print(
            f"\nДоля разобранных вопросов ниже {QUALITY_THRESHOLD:.0%} — "
            "выводы о расхождениях с базой делать нельзя, отчёт прерван.",
            file=sys.stderr,
        )
        return 1

    tickets = load_tickets(tickets_path)
    pdf_index = build_pdf_index(questions)
    same, different, not_found, ambiguous = compare_with_pdf(tickets, pdf_index)

    print()
    print(f"1. Совпало, правильный ответ тот же:  {len(same)}")
    print(f"2. Совпало, правильный ответ РАЗНЫЙ:  {len(different)}")
    print(f"3. В PDF не найдено:                  {len(not_found)}")
    if ambiguous:
        print(f"   исключено как неразличимое по тексту без картинки: {len(ambiguous)}")

    if ambiguous:
        print()
        print(
            "Билеты «тот же вопрос и ответы, но правильный ответ зависит от картинки»\n"
            "(группы такого рода уже известны по итогам шага 0 плана аудита) — сравнивать\n"
            "их с PDF по тексту нельзя, картинка в тексте не видна. Не входят в корзины 1-3:"
        )
        for t in ambiguous:
            print(f"  id={t['id']}: {t['question']}")

    if different:
        print()
        print(
            "Билеты с иным правильным ответом в PDF — это не приговор: расхождение\n"
            "означает либо ошибку парсера, либо то, что билет отредактировали после\n"
            "генерации PDF (22.12.2014). Проверять вручную:"
        )
        for item in different:
            t = item["ticket"]
            db_answer = t["answers"][t["correct"]]
            print(f"  id={t['id']}: {t['question']}")
            print(f"    у нас:  {db_answer}")
            print(f"    в PDF:  {item['pdf_correct_answer']} (вопрос {item['pdf_number']} в PDF)")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, help="путь к RU-B.pdf")
    parser.add_argument(
        "--tickets", default=str(DEFAULT_TICKETS_JSON), help="путь к JSON базы билетов"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check-parse", action="store_true", help="только оценить качество разбора PDF"
    )
    mode.add_argument(
        "--report", action="store_true", help="сверить базу с PDF и напечатать отчёт"
    )
    args = parser.parse_args(argv)

    if args.check_parse:
        return cmd_check_parse(args.pdf)
    return cmd_report(args.pdf, args.tickets)


if __name__ == "__main__":
    sys.exit(main())
