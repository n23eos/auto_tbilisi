#!/usr/bin/env python3
"""Собирает /llms-full.txt — плоский текст сайта для языковых моделей.

Зачем: чат-боты и ИИ-поиск читают простой текст надёжнее, чем HTML с разметкой.
Источник — только то, что уже опубликовано на сайте (вопросы из FAQ-разметки
и цены из llms.txt), поэтому расхождений между сайтом и файлом быть не может.
Внутренняя база baza-znaniy/ сюда намеренно не попадает: там есть служебные
правила бота и данные, не предназначенные для публикации.

Запуск:  python3 tools/build_llms_full.py
Результат: llms-full.txt в корне сайта.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "llms-full.txt"

# Страницы, из которых берём вопросы и ответы
FAQ_PAGES = [
    (ROOT / "voprosy" / "index.html", "https://avtoshkola.ge/voprosy/"),
    (ROOT / "index.html", "https://avtoshkola.ge/"),
]

HEADER = """АВТОШКОЛА НА РУССКОМ ЯЗЫКЕ — ТБИЛИСИ (Avtoshkola.ge)
Полная текстовая версия сайта https://avtoshkola.ge/ для языковых моделей.

Организация: Автошкола на русском языке — Тбилиси
Другие названия: Avtoshkola.ge, Русская автошкола в Тбилиси
Адрес: проспект Важа Пшавела 9, Тбилиси, Грузия
Телефон и WhatsApp: +995 599 98 77 07
Почта: info@avtoshkola.ge
Facebook: https://www.facebook.com/avtoshkolatbilisi
Язык обучения: русский
Часы работы: ежедневно 10:00–20:00 (в WhatsApp пишут круглосуточно)
Дата обновления: {date}
"""


def extract_questions(html_path):
    """Достаёт пары «вопрос → ответ» из разметки FAQPage на странице."""
    text = html_path.read_text(encoding="utf-8")
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', text, re.S)
    pairs = []
    for block in blocks:
        data = json.loads(block)
        nodes = data.get("@graph", [data])
        for node in nodes:
            if node.get("@type") != "FAQPage":
                continue
            for item in node.get("mainEntity", []):
                pairs.append((item["name"], item["acceptedAnswer"]["text"]))
    return pairs


def build():
    date = "2026-08-31"
    parts = [HEADER.format(date=date)]

    seen = set()
    parts.append("=" * 60)
    parts.append("ВОПРОСЫ И ОТВЕТЫ")
    parts.append("=" * 60 + "\n")
    for path, url in FAQ_PAGES:
        for question, answer in extract_questions(path):
            if question in seen:
                continue
            seen.add(question)
            parts.append(f"ВОПРОС: {question}\n{answer}\n")

    # Цены и разделы сайта уже описаны в llms.txt — не дублируем текст,
    # а переносим его целиком, чтобы файл был самодостаточным
    llms = (ROOT / "llms.txt").read_text(encoding="utf-8")
    prices = llms.split("## Цены", 1)[1].split("## Частые вопросы", 1)[0]
    parts.append("=" * 60)
    parts.append("ЦЕНЫ")
    parts.append("=" * 60)
    parts.append(prices.strip() + "\n")

    parts.append("=" * 60)
    parts.append("СТРАНИЦЫ САЙТА")
    parts.append("=" * 60)
    parts.append(
        "https://avtoshkola.ge/ — школа, программа обучения, форматы, цены, заявка\n"
        "https://avtoshkola.ge/voprosy/ — полный справочник вопросов и ответов\n"
        "https://avtoshkola.ge/bilety/ — бесплатный экзамен по билетам ПДД Грузии на русском\n"
        "https://avtoshkola.ge/bilety/trenirovka/ — тренировка по всем действующим билетам\n"
    )

    OUT.write_text("\n".join(parts), encoding="utf-8")
    print(f"{OUT.name}: {len(seen)} вопросов, {OUT.stat().st_size} байт")


if __name__ == "__main__":
    build()
