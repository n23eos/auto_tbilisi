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
