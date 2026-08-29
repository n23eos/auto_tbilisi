#!/usr/bin/env python3
"""Собирает из baza-znaniy/*.md файлы для загрузки в Meta Business Agent.

Зачем: markdown-таблицы, ссылки и разметку языковые модели в чат-ботах
разбирают плохо. Здесь всё превращается в простые строки «вопрос → ответ».

Запуск:  python3 tools/build_kb_txt.py

Результат в baza-znaniy/dlya-bota/:
  *.txt                     — база по темам, плоский текст
  baza-znaniy-polnaya.txt   — вся база одним файлом
  faq.csv                   — пары «вопрос → ответ» таблицей
  ceny.csv                  — прайс отдельной таблицей (данные в константе PRICES)
"""

import csv

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "baza-znaniy"
OUT_DIR = SRC_DIR / "dlya-bota"

# Файлы, которые идут в базу для бота, в порядке склейки
SOURCE_FILES = [
    "00-o-shkole.md",
    "01-obuchenie.md",
    "02-ceny-i-oplata.md",
    "03-dokumenty-i-dopusk.md",
    "04-ekzameny.md",
    "05-prava.md",
    "06-bystrye-fakty.md",
    "07-pravila-otvetov-bota.md",
    "08-iz-audio-shkoly.md",
    "09-fakt-cheking.md",
]

# Прайс отдельной таблицей: чат-агент отвечает по цене точнее, когда она лежит
# строкой в CSV, а не внутри абзаца. Правится здесь и в baza-znaniy/02-ceny-i-oplata.md.
PRICES = [
    ("Теория", "Группа в аудитории", "9 занятий по 90 минут за две недели, будни в 19:00, до 12 человек, пр-т Важа Пшавела 9. Преподаватель Нина", "150 ₾ за курс", "автошколе"),
    ("Теория", "Индивидуально онлайн (Людмила)", "10 занятий по 90 минут, 3-5 раз в неделю, время с 9:00 до 18:00, гибкий график", "280 ₾ за курс", "автошколе"),
    ("Теория", "Одно занятие онлайн", "если полный курс не нужен — после бесплатного тестирования", "28 ₾ за занятие", "автошколе"),
    ("Теория", "Индивидуально онлайн вечером или на дому (Нина)", "10 занятий, строго в одно и то же время, доступно вечернее время", "350 ₾ за курс", "автошколе"),
    ("Теория", "Индивидуально в аудитории", "формат есть, но аудитории почти всегда заняты — школа не рекомендует", "350 ₾ за курс", "автошколе"),
    ("Теория", "Онлайн вдвоём", "группу собирают сами ученики, цена с человека за курс", "210 ₾ с человека", "автошколе"),
    ("Теория", "Онлайн втроём", "группу собирают сами ученики, цена с человека за курс", "180 ₾ с человека", "автошколе"),
    ("Теория", "Онлайн вчетвером", "группу собирают сами ученики, цена с человека за курс", "150 ₾ с человека", "автошколе"),
    ("Вождение", "Площадка (автодром)", "занятие 45 минут у метро Церетели, механика или автомат — цена одна", "40 ₾ за занятие", "автошколе"),
    ("Вождение", "Город", "реальные маршруты Тбилиси с инструктором", "50 ₾ за занятие", "автошколе"),
    ("Дополнительно", "Тестирование", "10-20 минут, показывает, сколько занятий реально нужно", "бесплатно", "автошколе"),
    ("Дополнительно", "Консультация по телефону", "этапы, документы, пошлины, сроки", "бесплатно", "автошколе"),
    ("Дополнительно", "Медицинская справка формы 100", "выдаёт свой сертифицированный врач школы после осмотра", "45 ₾", "автошколе"),
    ("Дополнительно", "Справка об обучении", "нужна ученикам, которые выходят на экзамен в 17 лет", "50 ₾", "автошколе"),
    ("Государственная пошлина", "Экзамен по теории, первая попытка", "включает изготовление водительского удостоверения, оплата только грузинской картой", "55 ₾", "государству"),
    ("Государственная пошлина", "Пересдача теории", "каждая попытка, не раньше седьмого календарного дня", "40 ₾", "государству"),
    ("Государственная пошлина", "Экзамен по вождению в городе", "оплата при записи на сайте госуслуг", "90 ₾", "государству"),
    ("Государственная пошлина", "Пересдача площадки со второй попытки", "первая пересдача бесплатная", "40 ₾", "государству"),
    ("Государственная пошлина", "Ускоренная запись на экзамен по городу", "вместо 90 ₾ и ожидания — ближайшая дата, обычно через 2-3 дня", "250 ₾", "государству"),
    ("Государственная пошлина", "Международное водительское удостоверение", "по желанию, действует 3 года", "109 ₾", "государству"),
]


def strip_frontmatter(text):
    """Убирает YAML-шапку между --- в начале файла."""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            return parts[2].lstrip("\n")
    return text


def clean_inline(line):
    """Убирает markdown-разметку, оставляя читаемый текст и голые ссылки."""
    line = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1: \2", line)  # ссылка
    line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)  # внутренняя ссылка
    line = line.replace("**", "").replace("`", "")
    line = re.sub(r"(?<!\w)\*(?!\s)([^*]+)(?<!\s)\*(?!\w)", r"\1", line)  # курсив
    line = line.replace("⚠️", "ВНИМАНИЕ:").replace("> ", "")
    return line.strip()


def split_table_row(line):
    """Разбивает строку markdown-таблицы на ячейки."""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator_row(line):
    """Строка вида |---|---| под шапкой таблицы."""
    return bool(re.fullmatch(r"\|[\s:|-]+\|", line.strip()))


def flatten_table(rows):
    """Превращает таблицу в строки «Колонка: значение; Колонка: значение»."""
    if not rows:
        return []
    headers = split_table_row(rows[0])
    out = []
    for row in rows[1:]:
        cells = split_table_row(row)
        first = clean_inline(cells[0]) if cells else ""
        pairs = []
        for header, cell in zip(headers[1:], cells[1:]):
            cell = clean_inline(cell)
            if not cell:
                continue
            pairs.append(f"{clean_inline(header)}: {cell}")
        out.append(f"- {first} — " + "; ".join(pairs) if pairs else f"- {first}")
    return out


def convert(md_text):
    """Markdown → плоский текст с пометками ВОПРОС / РАЗДЕЛ."""
    lines = strip_frontmatter(md_text).split("\n")
    out = []
    table_buffer = []

    for raw in lines:
        line = raw.rstrip()

        # Копим таблицу целиком, чтобы знать её шапку
        if line.startswith("|"):
            if not is_separator_row(line):
                table_buffer.append(line)
            continue
        if table_buffer:
            out.extend(flatten_table(table_buffer))
            table_buffer = []

        if line.startswith("# "):
            out.append("")
            out.append("=" * 60)
            out.append("ТЕМА: " + clean_inline(line[2:]))
            out.append("=" * 60)
        elif line.startswith("## "):
            title = clean_inline(line[3:])
            out.append("")
            out.append(("ВОПРОС: " if title.endswith("?") else "РАЗДЕЛ: ") + title)
        elif line.startswith("### "):
            out.append("")
            out.append(clean_inline(line[4:]).upper())
        else:
            out.append(clean_inline(line))

    if table_buffer:
        out.extend(flatten_table(table_buffer))

    # Схлопываем тройные пустые строки в одну пустую
    result = []
    for line in out:
        if line == "" and result and result[-1] == "":
            continue
        result.append(line)
    return "\n".join(result).strip() + "\n"


def extract_qa(md_text, tema):
    """Достаёт из markdown пары «заголовок → текст под ним» для FAQ-таблицы."""
    lines = strip_frontmatter(md_text).split("\n")
    pairs = []
    question = None
    body = []
    table_buffer = []

    def flush():
        if question is None:
            return
        text = "\n".join(body).strip()
        text = re.sub(r"\n{3,}", "\n\n", text)
        if text:
            pairs.append((tema, question, text))

    for raw in lines:
        line = raw.rstrip()

        if line.startswith("|"):
            if not is_separator_row(line):
                table_buffer.append(line)
            continue
        if table_buffer:
            body.extend(flatten_table(table_buffer))
            table_buffer = []

        if line.startswith("## "):
            flush()
            question = clean_inline(line[3:])
            body = []
        elif line.startswith("# "):
            continue
        elif line.startswith("### "):
            body.append(clean_inline(line[4:]) + ":")
        elif question is not None:
            body.append(clean_inline(line))

    if table_buffer:
        body.extend(flatten_table(table_buffer))
    flush()
    return pairs


def write_faq_csv(pairs):
    """FAQ таблицей: тема, вопрос, ответ. Кодировка UTF-8 с BOM — чтобы
    файл корректно открывался в Excel и Google Таблицах."""
    path = OUT_DIR / "faq.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Тема", "Вопрос", "Ответ"])
        writer.writerows(pairs)
    return path


def write_prices_csv():
    """Прайс таблицей: категория, услуга, что входит, цена, кому платится."""
    path = OUT_DIR / "ceny.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Категория", "Услуга", "Что входит", "Цена", "Кому платится"])
        writer.writerows(PRICES)
    return path


def get_tema(md_text, fallback):
    """Заголовок # из файла — он же тема для CSV."""
    for line in strip_frontmatter(md_text).split("\n"):
        if line.startswith("# "):
            return clean_inline(line[2:])
    return fallback


def main():
    OUT_DIR.mkdir(exist_ok=True)
    qa_pairs = []
    combined = [
        "БАЗА ЗНАНИЙ — АВТОШКОЛА НА РУССКОМ ЯЗЫКЕ, ТБИЛИСИ",
        "Сайт: https://avtoshkola.ge  Телефон: +995 599 98 77 07",
        "Всё, что нужно знать боту для ответов клиентам.",
        "",
    ]

    for name in SOURCE_FILES:
        src = SRC_DIR / name
        if not src.exists():
            print(f"пропущен (нет файла): {name}")
            continue
        md_text = src.read_text(encoding="utf-8")
        text = convert(md_text)
        out_path = OUT_DIR / (src.stem + ".txt")
        out_path.write_text(text, encoding="utf-8")
        combined.append(text)
        qa_pairs.extend(extract_qa(md_text, get_tema(md_text, src.stem)))
        print(f"готово: {out_path.relative_to(ROOT)}  ({len(text)} символов)")

    full = OUT_DIR / "baza-znaniy-polnaya.txt"
    full.write_text("\n".join(combined), encoding="utf-8")
    print(f"готово: {full.relative_to(ROOT)}  ({full.stat().st_size} байт)")

    faq = write_faq_csv(qa_pairs)
    print(f"готово: {faq.relative_to(ROOT)}  ({len(qa_pairs)} пар вопрос-ответ)")

    prices = write_prices_csv()
    print(f"готово: {prices.relative_to(ROOT)}  ({len(PRICES)} строк прайса)")


if __name__ == "__main__":
    main()
