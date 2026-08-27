"""Тесты разбора PDF-сборника билетов и сверки с базой.

Работают на фикстурах (списки блоков, готовые списки вопросов) — ни один
тест не открывает живой PDF: 78-мегабайтный файл в тестах не нужен, разбор
проверяется на заранее подготовленных данных.
"""

from tools import audit_tickets as audit

# Фикстура из плана аудита (docs/superpowers/plans/2026-08-27-tickets-audit.md,
# Task 1 Step 1) — блоки одной страницы PDF в формате (x0, y0, текст).
BLOCKS = [
    (28.4, 68.6, "ВОПРОС 1 ПРАВИЛЬНЫЙ ОТВЕТ: 2"),
    (47.6, 309.2, "1 2"),
    (47.6, 365.2, "3"),
    (53.5, 232.6, "Из данных опознавательных знаков, который является «Различающим знаком»"),
    (73.2, 302.9, "I"),
    (346.8, 302.9, "II"),
    (73.2, 358.9, "III"),
    (255.1, 424.1, "განმარტება: пояснение"),
]


def test_parse_pdf_question_reads_number_and_correct():
    question = audit.parse_pdf_blocks(BLOCKS)[0]
    assert question["number"] == 1
    assert question["correct"] == 1  # в PDF нумерация с единицы, у нас с нуля


def test_parse_pdf_question_orders_answers_by_position():
    question = audit.parse_pdf_blocks(BLOCKS)[0]
    assert question["answers"] == ["I", "II", "III"]


def test_parse_pdf_question_drops_georgian_explanation():
    question = audit.parse_pdf_blocks(BLOCKS)[0]
    assert all("განმარტება" not in a for a in question["answers"])
    assert "განმარტება" not in question["question"]


def test_parse_pdf_blocks_handles_two_questions_on_one_page():
    """На одной странице бывает несколько вопросов — второй заголовок открывает новый."""
    two_questions = BLOCKS + [
        (28.4, 500.0, "ВОПРОС 2 ПРАВИЛЬНЫЙ ОТВЕТ: 1"),
        (73.2, 540.0, "Да"),
        (346.8, 540.0, "Нет"),
    ]
    questions = audit.parse_pdf_blocks(two_questions)
    assert [q["number"] for q in questions] == [1, 2]
    assert questions[1]["correct"] == 0
    assert questions[1]["answers"] == ["Да", "Нет"]


def test_parse_pdf_blocks_drops_number_label_even_with_space():
    """Блок-номер вида «1 2» (без переноса строки) не должен попасть в ответы."""
    question = audit.parse_pdf_blocks(BLOCKS)[0]
    assert "1 2" not in question["answers"]
    assert "3" not in question["answers"]


def test_merge_wrapped_lines_joins_lines_with_small_gap():
    """Перенос текста одного ответа на несколько строк — маленький разрыв по Y."""
    lines = [
        (73.2, 128.5, 140.7, "Только в случае приостановления"),
        (73.2, 142.9, 155.1, "соответствующего права на"),
        (73.2, 157.3, 169.5, "управление"),
    ]
    merged = audit._merge_wrapped_lines(lines)
    assert merged == [
        (73.2, 128.5, "Только в случае приостановления соответствующего права на управление")
    ]


def test_merge_wrapped_lines_keeps_separate_answers_with_big_gap():
    """Между двумя РАЗНЫМИ ответами в одной колонке разрыв на порядок больше."""
    lines = [
        (73.2, 128.5, 140.7, "Только в случае приостановления"),
        (73.2, 211.7, 223.9, "Как в случае приостановления"),
    ]
    merged = audit._merge_wrapped_lines(lines)
    assert merged == [
        (73.2, 128.5, "Только в случае приостановления"),
        (73.2, 211.7, "Как в случае приостановления"),
    ]


def test_normalize_text_lowercases_and_unifies_punctuation():
    assert audit.normalize_text("  Ёлка «в лесу» — стоит.  ") == 'елка "в лесу" - стоит'


def test_normalize_text_strips_trailing_punctuation():
    assert audit.normalize_text("Обязан?") == "обязан"


def test_ticket_key_ignores_answer_order():
    """Порядок ответов у источников может отличаться — сравниваем набором."""
    key_a = audit.ticket_key("Вопрос?", ["Да", "Нет"])
    key_b = audit.ticket_key("Вопрос?", ["Нет", "Да"])
    assert key_a == key_b


def test_check_parse_quality_counts_fully_parsed_questions():
    questions = [
        {"number": 1, "correct": 0, "question": "Вопрос", "answers": ["Да", "Нет"]},
        {"number": 2, "correct": 5, "question": "Вопрос", "answers": ["Да", "Нет"]},  # плохой correct
        {"number": 3, "correct": 0, "question": "", "answers": ["Да", "Нет"]},  # пустой вопрос
    ]
    stats = audit.check_parse_quality(questions)
    assert stats["total"] == 3
    assert stats["fully_ok"] == 1


def test_compare_with_pdf_buckets_matches_by_question_and_answer_set():
    """Три корзины: тот же ответ, разный ответ, не найдено в PDF."""
    tickets = [
        {"id": 1, "question": "Обязан?", "answers": ["Да", "Нет"], "correct": 0},
        {"id": 2, "question": "Кто прав?", "answers": ["Первый", "Второй"], "correct": 1},
        {"id": 3, "question": "Новый вопрос", "answers": ["А", "Б"], "correct": 0},
    ]
    pdf_questions = [
        {"number": 10, "correct": 0, "question": "Обязан?", "answers": ["Да", "Нет"]},
        {"number": 11, "correct": 1, "question": "Кто прав?", "answers": ["Второй", "Первый"]},
    ]
    pdf_index = audit.build_pdf_index(pdf_questions)
    same, different, not_found, ambiguous = audit.compare_with_pdf(tickets, pdf_index)

    assert [t["id"] for t in same] == [1]
    assert [item["ticket"]["id"] for item in different] == [2]
    assert different[0]["pdf_correct_answer"] == "Первый"
    assert [t["id"] for t in not_found] == [3]
    assert ambiguous == []


def test_compare_with_pdf_flags_image_dependent_duplicates_as_ambiguous():
    """Билеты «тот же текст, разные картинки» нельзя сравнить с PDF по тексту —
    правильный ответ у них зависит от картинки (см. Итог шага 0 плана аудита)."""
    tickets = [
        {"id": 1, "question": "Кто уступает?", "answers": ["Грузовик", "Легковая"], "correct": 0},
        {"id": 2, "question": "Кто уступает?", "answers": ["Легковая", "Грузовик"], "correct": 1},
    ]
    pdf_questions = [
        {"number": 1, "correct": 0, "question": "Кто уступает?", "answers": ["Грузовик", "Легковая"]},
    ]
    pdf_index = audit.build_pdf_index(pdf_questions)
    same, different, not_found, ambiguous = audit.compare_with_pdf(tickets, pdf_index)

    assert same == different == not_found == []
    assert [t["id"] for t in ambiguous] == [1, 2]
