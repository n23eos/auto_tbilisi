"""Сгенерированная база для бота должна соответствовать своим исходникам.

Цепочка сборки: baza-znaniy/*.md → tools/build_kb_txt.py → baza-znaniy/dlya-bota/*.txt
→ bot/scripts/build-kb.mjs → bot/src/generated/kb.ts.

Второе звено защищено само: `npm run deploy` в bot/ всегда запускает build-kb.
А первое — нет. Правка .md без запуска build_kb_txt.py молча уезжает в прод
старой базой: бот отвечает ученикам прошлыми ценами, и ничто об этом не скажет.
Эти тесты и есть недостающая проверка первого звена.
"""

import pytest

from tools import build_kb_txt as kb


@pytest.mark.parametrize("name", kb.SOURCE_FILES)
def test_generated_txt_matches_markdown_source(name):
    """dlya-bota/<имя>.txt — ровно то, что даёт convert() из <имя>.md сегодня."""
    md_path = kb.SRC_DIR / name
    txt_path = kb.OUT_DIR / (md_path.stem + ".txt")

    assert md_path.exists(), f"нет исходника {md_path}"
    assert txt_path.exists(), (
        f"нет собранного {txt_path} — запустите: python3 tools/build_kb_txt.py"
    )

    expected = kb.convert(md_path.read_text(encoding="utf-8"))
    actual = txt_path.read_text(encoding="utf-8")
    assert actual == expected, (
        f"{txt_path.name} разошёлся с {md_path.name}. "
        "Пересоберите базу: python3 tools/build_kb_txt.py"
    )


def test_combined_file_is_concatenation_of_parts():
    """baza-znaniy-polnaya.txt — склейка тех же кусков, а не отдельная копия."""
    combined = (kb.OUT_DIR / "baza-znaniy-polnaya.txt").read_text(encoding="utf-8")
    for name in kb.SOURCE_FILES:
        part = (kb.OUT_DIR / (kb.SRC_DIR / name).stem).with_suffix(".txt")
        assert part.read_text(encoding="utf-8") in combined, (
            f"{part.name} не вошёл в baza-znaniy-polnaya.txt. "
            "Пересоберите базу: python3 tools/build_kb_txt.py"
        )
