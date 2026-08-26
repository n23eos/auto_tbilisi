"""Парсер экзаменационных билетов ПДД Грузии (категория B/B1, русский язык).

Источник: https://teoria.on.ge
Спека: docs/superpowers/specs/2026-08-26-pdd-tickets-db-design.md

Скрипт намеренно ограничен одной категорией и одним языком: значения ниже —
константы, из них выводятся URL, cookie, имя JSON и путь к картинкам.
"""

import re
from urllib.parse import urljoin

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
                "source": f"{BASE_URL}/tickets?ticket={ticket_id}" if ticket_id else None,
            }
        )
    return tickets
