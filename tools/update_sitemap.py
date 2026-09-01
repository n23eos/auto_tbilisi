#!/usr/bin/env python3
"""Обновляет <lastmod> в sitemap.xml датами последних правок страниц.

Зачем: даты правились руками и разъезжались. На момент написания у всех
четырёх страниц стояла одна и та же дата — день, когда кто-то последний раз
вспомнил про файл, а не день, когда менялась сама страница. Поисковику это
говорит «всё обновлено разом», то есть не говорит ничего.

Дата берётся из git по каждой странице отдельно, поэтому соврать не может:
она из той же правки, что и текст.

Запуск:  python3 tools/update_sitemap.py
"""

import re
import subprocess
from datetime import date as date_cls
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITEMAP = ROOT / "sitemap.xml"

# Адрес в карте сайта → файл, который за него отвечает.
PAGES = {
    "https://avtoshkola.ge/": "index.html",
    "https://avtoshkola.ge/voprosy/": "voprosy/index.html",
    "https://avtoshkola.ge/bilety/": "bilety/index.html",
    "https://avtoshkola.ge/bilety/trenirovka/": "bilety/trenirovka/index.html",
}


def last_change(path):
    """Дата последней правки файла в git, ISO. Без git — сегодняшняя."""
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", path],
            capture_output=True, text=True, check=True, cwd=ROOT,
        )
    except (OSError, subprocess.CalledProcessError):
        return date_cls.today().isoformat()
    return result.stdout.strip() or date_cls.today().isoformat()


def render(xml, pages=PAGES):
    """Возвращает карту сайта с обновлёнными датами. Файл не трогает."""
    for url, path in pages.items():
        # Ищем <lastmod> строго внутри того же <url>, что и нужный <loc>:
        # иначе первая же замена переписала бы дату соседней страницы.
        pattern = re.compile(
            r"(<loc>" + re.escape(url) + r"</loc>\s*<lastmod>)[^<]+(</lastmod>)"
        )
        if not pattern.search(xml):
            raise ValueError(f"В sitemap.xml нет записи с <loc>{url}</loc> и <lastmod>")
        xml = pattern.sub(lambda m: m.group(1) + last_change(path) + m.group(2), xml)
    return xml


def main():
    xml = SITEMAP.read_text(encoding="utf-8")
    updated = render(xml)
    SITEMAP.write_text(updated, encoding="utf-8")
    print("sitemap.xml обновлён" if updated != xml else "sitemap.xml уже актуален")


if __name__ == "__main__":
    main()
