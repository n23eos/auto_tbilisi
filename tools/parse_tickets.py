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
