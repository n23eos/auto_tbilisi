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


def test_parse_tickets_gives_null_source_for_unparsable_id():
    html = '<article class="ticket-container locale-ru"><div class="t-num">#абв</div>' \
           '<div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос</span></p></div>' \
           '<div class="t-cover"><p class="t-answer t-answer-1" data-is-correct-list="true">' \
           '<span class="t-a-text"><span class="text-wrap">Ответ</span></span></p></div></article>'
    ticket = pt.parse_tickets(html, PAGE_URL)[0]
    assert ticket["id"] is None
    assert ticket["source"] is None


def test_parse_tickets_rejects_two_correct_marks():
    html = '<article class="ticket-container locale-ru"><div class="t-num">#3</div>' \
           '<div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос</span></p></div>' \
           '<div class="t-cover">' \
           '<p class="t-answer t-answer-1" data-is-correct-list="true"><span class="t-a-text"><span class="text-wrap">A</span></span></p>' \
           '<p class="t-answer t-answer-2" data-is-correct-list="true"><span class="t-a-text"><span class="text-wrap">Б</span></span></p>' \
           '</div></article>'
    ticket = pt.parse_tickets(html, PAGE_URL)[0]
    assert ticket["correct"] is None
    errors = pt.validate([ticket], total=1, pages_seen={1: 1}, page_count=1)
    assert errors  # такой билет база принять не должна


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
    assert any("меньше" in e for e in errors)


def test_validate_catches_empty_answer_text():
    tickets = [make_ticket(answers=["Ответ 1", ""])]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("пустой ответ" in e for e in errors)


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


def test_validate_catches_page_counts_not_matching_total():
    tickets = [make_ticket(id=1), make_ticket(id=2)]
    errors = pt.validate(tickets, total=2, pages_seen={1: 1, 2: 5}, page_count=2)
    assert any("со страниц собрано" in e for e in errors)


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
