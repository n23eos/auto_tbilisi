"""Тесты обновления дат в sitemap.xml."""

import re

import pytest

from tools.update_sitemap import PAGES, SITEMAP, last_change, render

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.test/a/</loc>
    <lastmod>1999-01-01</lastmod>
  </url>
  <url>
    <loc>https://example.test/b/</loc>
    <lastmod>1999-01-01</lastmod>
  </url>
</urlset>
"""


def test_last_change_returns_iso_date():
    assert ISO_DATE.match(last_change("index.html"))


def test_updates_only_the_named_page():
    """Замена не должна задевать соседние записи.

    Наивный поиск «первый <lastmod> после начала файла» переписал бы дату
    не той страницы, и ошибку было бы видно только в вебмастере.
    """
    out = render(SAMPLE, pages={"https://example.test/b/": "index.html"})
    assert "<loc>https://example.test/a/</loc>\n    <lastmod>1999-01-01</lastmod>" in out
    assert "<lastmod>1999-01-01</lastmod>" in out
    b_date = re.search(
        r"<loc>https://example\.test/b/</loc>\s*<lastmod>([^<]+)</lastmod>", out
    ).group(1)
    assert b_date != "1999-01-01"
    assert ISO_DATE.match(b_date)


def test_missing_url_is_an_error():
    """Молча ничего не обновить хуже, чем упасть: файл выглядел бы свежим."""
    with pytest.raises(ValueError, match="нет записи"):
        render(SAMPLE, pages={"https://example.test/missing/": "index.html"})


def test_real_sitemap_lists_every_known_page():
    xml = SITEMAP.read_text(encoding="utf-8")
    for url in PAGES:
        assert f"<loc>{url}</loc>" in xml


def test_real_sitemap_is_up_to_date():
    """Карта сайта в репозитории должна совпадать с тем, что даёт скрипт."""
    xml = SITEMAP.read_text(encoding="utf-8")
    assert render(xml) == xml
