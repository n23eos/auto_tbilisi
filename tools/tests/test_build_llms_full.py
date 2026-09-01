"""Тесты сборки llms-full.txt: дату берём из истории, а не из литерала в коде."""

import re
import subprocess

from tools.build_llms_full import build, content_date

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def test_content_date_is_iso():
    assert ISO_DATE.match(content_date())


def test_content_date_matches_git_log_of_sources():
    """Дата обновления — дата последней правки страниц, из которых собран файл.

    Захардкоженная дата разъезжается с содержимым молча: файл пересобирают,
    а «Дата обновления» остаётся прошлогодней — и языковая модель считает
    устаревшими актуальные цены.
    """
    expected = subprocess.run(
        ["git", "log", "-1", "--format=%cs", "--", "index.html", "voprosy/index.html", "llms.txt"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert content_date() == expected


def test_header_carries_the_computed_date():
    assert f"Дата обновления: {content_date()}" in build()
