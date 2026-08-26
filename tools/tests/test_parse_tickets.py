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
