"""Тесты сборки плоской базы знаний из markdown (tools/build_kb_txt.py)."""

from tools import build_kb_txt as kb


REAL_FRONTMATTER = """---
тема: О школе
обновлено: 2026-08-28
---

# О школе

Текст.
"""


def test_strip_frontmatter_removes_yaml_header():
    out = kb.strip_frontmatter(REAL_FRONTMATTER)
    assert out.startswith("# О школе")
    assert "тема:" not in out


def test_strip_frontmatter_keeps_text_without_header():
    text = "# О школе\n\nТекст.\n"
    assert kb.strip_frontmatter(text) == text


def test_strip_frontmatter_survives_dashes_inside_a_value():
    """«---» внутри значения шапки не должно обрезать файл.

    Шапки в baza-znaniy заполняются свободным текстом по-русски, и тире там
    вполне может встретиться. Поиск по подстроке принимал такое тире за конец
    шапки: терялся заголовок # Тема, а в тексте оставался огрызок «---».
    """
    text = "---\nтема: Цены --- обновлено\n---\n\n# Цены\n\nТекст.\n"
    out = kb.strip_frontmatter(text)
    assert out.startswith("# Цены")
    assert "---" not in out
    assert "обновлено" not in out


def test_strip_frontmatter_ignores_horizontal_rules_without_header():
    """Файл без шапки не теряет текст между markdown-разделителями."""
    text = "# Тема\n\nПервая часть.\n\n---\n\nВторая часть.\n"
    assert kb.strip_frontmatter(text) == text


def test_strip_frontmatter_keeps_text_when_header_is_never_closed():
    """Незакрытая шапка — не повод молча съесть остаток файла."""
    text = "---\nтема: без закрывающей строки\n\n# Тема\n\nТекст.\n"
    assert kb.strip_frontmatter(text) == text


def test_convert_keeps_heading_when_value_contains_dashes():
    """Сквозная проверка: заголовок доезжает до ТЕМА, а не теряется по дороге."""
    text = "---\nтема: Цены --- обновлено\n---\n\n# Цены\n\n## Сколько стоит?\nСто пятьдесят лари.\n"
    out = kb.convert(text)
    assert "ТЕМА: Цены" in out
    assert "ВОПРОС: Сколько стоит?" in out
