import io
import re
from pathlib import Path

import pytest
from PIL import Image

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


def test_parse_tickets_returns_all_articles(html_ru):
    tickets = pt.parse_tickets(html_ru, PAGE_URL)
    assert [t["id"] for t in tickets] == [1, 2, 4, 7]


def test_parse_tickets_reads_question_and_answers(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert ticket["question"] == "Вопрос один"
    assert ticket["answers"] == ["Ответ 1-1", "Ответ 1-2"]
    assert ticket["correct"] == 1
    assert ticket["source"] == "https://teoria.on.ge/tickets?ticket=1"


def test_parse_tickets_skips_empty_answer_slots(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert len(ticket["answers"]) == 2


def test_parse_tickets_handles_ticket_without_image(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[1]
    assert ticket["image_url"] is None
    assert ticket["answers"] == ["Ответ 2-1", "Ответ 2-2", "Ответ 2-3"]
    assert ticket["correct"] == 0


def test_parse_tickets_resolves_absolute_image_url(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert ticket["image_url"] == "http://teoria.on.ge/files/new/aaa111.jpg"


def test_parse_tickets_resolves_protocol_relative_image_url(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[2]
    assert ticket["image_url"] == "https://static.on.ge/teoria/ccc333.jpg"


def test_parse_tickets_resolves_relative_image_url(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[3]
    assert ticket["image_url"] == "https://teoria.on.ge/files/new/ddd444.jpg"


def test_parse_tickets_keeps_ticket_without_correct_marker(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[3]
    assert ticket["id"] == 7
    assert ticket["correct"] is None


def test_parse_tickets_gives_null_source_for_unparsable_id():
    html = '<article class="ticket-container locale-ru"><div class="t-num">#абв</div>' \
           '<div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос</span></p></div>' \
           '<div class="t-cover"><p class="t-answer t-answer-1" data-is-correct-list="true">' \
           '<span class="t-a-text"><span class="text-wrap">Ответ</span></span></p></div></article>'
    ticket = pt.parse_tickets(html, PAGE_URL)[0]
    assert ticket["id"] is None
    assert ticket["source"] is None


def test_parse_tickets_rejects_two_correct_marks():
    html = '<article class="ticket-container locale-ru"><div class="t-num">#3</div>' \
           '<div class="t-question"><p class="t-question-inner"><span class="text-wrap">Вопрос</span></p></div>' \
           '<div class="t-cover">' \
           '<p class="t-answer t-answer-1" data-is-correct-list="true"><span class="t-a-text"><span class="text-wrap">A</span></span></p>' \
           '<p class="t-answer t-answer-2" data-is-correct-list="true"><span class="t-a-text"><span class="text-wrap">Б</span></span></p>' \
           '</div></article>'
    ticket = pt.parse_tickets(html, PAGE_URL)[0]
    assert ticket["correct"] is None
    errors = pt.validate([ticket], total=1, pages_seen={1: 1}, page_count=1)
    assert errors  # такой билет база принять не должна


def test_parse_tickets_marks_russian_ticket_with_ru(html_ru):
    ticket = pt.parse_tickets(html_ru, PAGE_URL)[0]
    assert ticket["lang"] == "ru"


def test_parse_tickets_marks_untranslated_ticket_with_ka(html_ka):
    # У источника есть билеты (например, подкатегория «эко-вождение»), для
    # которых русского перевода нет ни при какой локали — вопрос приходит
    # на грузинском. Такой билет не бракуем, а помечаем lang="ka".
    ticket = pt.parse_tickets(html_ka, PAGE_URL)[0]
    assert ticket["lang"] == "ka"


def make_ticket(**overrides):
    """Заведомо валидный билет; поля переопределяются под конкретный тест."""
    ticket = {
        "id": 1,
        "question": "Вопрос",
        "answers": ["Ответ 1", "Ответ 2"],
        "correct": 0,
        "image_url": None,
        "image": None,
        "source": "https://teoria.on.ge/tickets?ticket=1",
    }
    ticket.update(overrides)
    return ticket


def test_validate_accepts_good_database():
    tickets = [make_ticket(id=1), make_ticket(id=2)]
    assert pt.validate(tickets, total=2, pages_seen={1: 2}, page_count=1) == []


def test_validate_catches_duplicate_ids():
    tickets = [make_ticket(id=5), make_ticket(id=5)]
    errors = pt.validate(tickets, total=2, pages_seen={1: 2}, page_count=1)
    assert any("дубл" in e for e in errors)


def test_validate_catches_empty_question():
    tickets = [make_ticket(question="")]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("вопрос" in e for e in errors)


def test_validate_catches_non_positive_id():
    tickets = [make_ticket(id=0)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("id" in e for e in errors)


def test_validate_catches_missing_id():
    tickets = [make_ticket(id=None)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("id" in e for e in errors)


def test_validate_catches_single_answer():
    tickets = [make_ticket(answers=["Только один"], correct=0)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("меньше" in e for e in errors)


def test_validate_catches_empty_answer_text():
    tickets = [make_ticket(answers=["Ответ 1", ""])]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("пустой ответ" in e for e in errors)


def test_validate_catches_missing_correct():
    tickets = [make_ticket(correct=None)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("правильн" in e for e in errors)


def test_validate_catches_correct_out_of_range():
    tickets = [make_ticket(correct=2)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("правильн" in e for e in errors)


def test_validate_catches_correct_not_integer():
    tickets = [make_ticket(correct=True)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("правильн" in e for e in errors)


def test_validate_catches_ticket_count_mismatch():
    tickets = [make_ticket(id=1)]
    errors = pt.validate(tickets, total=921, pages_seen={1: 1}, page_count=1)
    assert any("921" in e for e in errors)


def test_validate_catches_page_counts_not_matching_total():
    tickets = [make_ticket(id=1), make_ticket(id=2)]
    errors = pt.validate(tickets, total=2, pages_seen={1: 1, 2: 5}, page_count=2)
    assert any("со страниц собрано" in e for e in errors)


def test_validate_catches_missing_page():
    tickets = [make_ticket(id=1), make_ticket(id=2)]
    errors = pt.validate(tickets, total=2, pages_seen={1: 2}, page_count=3)
    assert any("страниц" in e for e in errors)


def test_validate_catches_empty_page():
    tickets = [make_ticket(id=1)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1, 2: 0}, page_count=2)
    assert any("пуст" in e for e in errors)


def test_validate_catches_lost_image():
    tickets = [make_ticket(image_url="https://teoria.on.ge/a.jpg", image=None)]
    errors = pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1)
    assert any("картинк" in e for e in errors)


def test_validate_allows_null_image_when_source_has_none():
    tickets = [make_ticket(image_url=None, image=None)]
    assert pt.validate(tickets, total=1, pages_seen={1: 1}, page_count=1) == []


def test_is_page_html_valid_accepts_ru_page(html_ru):
    assert pt.is_page_html_valid(html_ru) is True


def test_is_page_html_valid_rejects_other_locale(html_ka):
    assert pt.is_page_html_valid(html_ka) is False


def test_is_page_html_valid_rejects_empty():
    assert pt.is_page_html_valid("") is False


def test_is_page_html_valid_rejects_other_category(html_ru):
    assert pt.is_page_html_valid(html_ru.replace('/tickets/2', '/tickets/5')) is False


def test_cache_roundtrip(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    assert pt.read_cached_page(3) is None
    pt.write_cached_page(3, html_ru)
    assert pt.read_cached_page(3) == html_ru


def test_read_cached_page_rejects_wrong_locale(tmp_path, monkeypatch, html_ka):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    (tmp_path / "page-1.html").write_text(html_ka, encoding="utf-8")
    assert pt.read_cached_page(1) is None


def test_read_cached_page_rejects_empty_file(tmp_path, monkeypatch):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    (tmp_path / "page-1.html").write_text("", encoding="utf-8")
    assert pt.read_cached_page(1) is None


def test_write_cached_page_uses_atomic_replace(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    calls = []
    real_replace = pt.os.replace

    def spy_replace(src, dst):
        calls.append((str(src), str(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr(pt.os, "replace", spy_replace)
    pt.write_cached_page(1, html_ru)
    assert len(calls) == 1
    src, dst = calls[0]
    assert src.endswith(".tmp")
    assert dst.endswith("page-1.html")
    assert [p.name for p in tmp_path.iterdir()] == ["page-1.html"]


def test_write_cached_page_cleans_up_tmp_on_failure(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)

    def failing_replace(src, dst):
        raise OSError("диск полон")

    monkeypatch.setattr(pt.os, "replace", failing_replace)
    with pytest.raises(OSError):
        pt.write_cached_page(1, html_ru)
    assert not list(tmp_path.glob("*.tmp"))


def _write_png(path, size=(8, 8)):
    Image.new("RGB", size, (10, 120, 200)).save(path, format="PNG")


def _write_jpeg_bytes(size=(64, 64)):
    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 60, 10)).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_verify_image_accepts_real_png(tmp_path):
    path = tmp_path / "good.png"
    _write_png(path)
    assert pt.verify_image(path) is True


def test_verify_image_rejects_html_with_jpg_extension(tmp_path):
    path = tmp_path / "cloudflare.jpg"
    path.write_text("<html><body>Attention Required! | Cloudflare</body></html>", encoding="utf-8")
    assert pt.verify_image(path) is False


def test_verify_image_rejects_truncated_jpeg(tmp_path):
    data = _write_jpeg_bytes()
    path = tmp_path / "truncated.jpg"
    path.write_bytes(data[: len(data) // 2])
    # Магические байты у обрезанного файла верные — поймать может только декодирование.
    assert path.read_bytes()[:2] == b"\xff\xd8"
    assert pt.verify_image(path) is False


def test_verify_image_rejects_missing_file(tmp_path):
    assert pt.verify_image(tmp_path / "нет-такого.jpg") is False


class FakeResponse:
    def __init__(self, content, content_type="image/jpeg", status=200):
        self.content = content
        self.headers = {"Content-Type": content_type}
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        return self.response


def test_download_image_saves_valid_image(tmp_path):
    session = FakeSession(FakeResponse(_write_jpeg_bytes()))
    dest = tmp_path / "a.jpg"
    assert pt.download_image(session, "https://example.com/a.jpg", dest) is True
    assert dest.exists()


def test_download_image_rejects_non_image_content_type(tmp_path):
    # Тело — валидный JPEG: отбраковать его может только проверка Content-Type.
    session = FakeSession(FakeResponse(_write_jpeg_bytes(), content_type="text/html"))
    dest = tmp_path / "b.jpg"
    assert pt.download_image(session, "https://example.com/b.jpg", dest) is False
    assert not dest.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_download_image_rejects_corrupt_body_and_removes_file(tmp_path):
    session = FakeSession(FakeResponse(b"not an image at all", content_type="image/jpeg"))
    dest = tmp_path / "c.jpg"
    assert pt.download_image(session, "https://example.com/c.jpg", dest) is False
    assert not dest.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_download_image_skips_existing_valid_file(tmp_path):
    dest = tmp_path / "d.png"
    _write_png(dest)
    session = FakeSession(FakeResponse(b"", content_type="image/jpeg"))
    assert pt.download_image(session, "https://example.com/d.png", dest) is True
    assert session.calls == 0


def test_download_image_redownloads_existing_broken_file(tmp_path):
    dest = tmp_path / "e.jpg"
    dest.write_text("<html>мусор с прошлого запуска</html>", encoding="utf-8")
    session = FakeSession(FakeResponse(_write_jpeg_bytes()))
    assert pt.download_image(session, "https://example.com/e.jpg", dest) is True
    assert session.calls == 1
    assert pt.verify_image(dest) is True


def test_download_image_cleans_up_tmp_on_replace_failure(tmp_path, monkeypatch):
    session = FakeSession(FakeResponse(_write_jpeg_bytes()))
    dest = tmp_path / "f.jpg"

    def failing_replace(src, dst):
        raise OSError("диск полон")

    monkeypatch.setattr(pt.os, "replace", failing_replace)
    with pytest.raises(OSError):
        pt.download_image(session, "https://example.com/f.jpg", dest)
    assert not list(tmp_path.glob("*.tmp"))
    assert not dest.exists()


class FlakySession:
    """Отдаёт ошибку первые fail_times вызовов, потом — страницу."""

    def __init__(self, html, fail_times=0):
        self.html = html
        self.fail_times = fail_times
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("сеть отвалилась")
        return FakeResponse(self.html.encode("utf-8"), content_type="text/html")


def test_fetch_page_uses_cache_without_network(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    pt.write_cached_page(1, html_ru)
    session = FlakySession(html_ru)
    assert pt.fetch_page(session, 1) == html_ru
    assert session.calls == 0


def test_fetch_page_downloads_and_caches(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    session = FlakySession(html_ru)
    assert pt.fetch_page(session, 2) == html_ru
    assert session.calls == 1
    assert pt.read_cached_page(2) == html_ru


def test_fetch_page_ignores_cache_with_refresh(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    pt.write_cached_page(1, html_ru)
    session = FlakySession(html_ru)
    pt.fetch_page(session, 1, refresh=True)
    assert session.calls == 1


def test_fetch_page_retries_then_succeeds(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    monkeypatch.setattr(pt, "RETRY_BACKOFF_SEC", 0)
    session = FlakySession(html_ru, fail_times=2)
    assert pt.fetch_page(session, 1) == html_ru
    assert session.calls == 3


def test_fetch_page_raises_after_all_retries(tmp_path, monkeypatch, html_ru):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    monkeypatch.setattr(pt, "RETRY_BACKOFF_SEC", 0)
    session = FlakySession(html_ru, fail_times=99)
    # Матчим номер страницы, а не просто слово "страниц" — иначе пропажа
    # номера из сообщения останется незамеченной.
    with pytest.raises(RuntimeError, match=r"страница 4"):
        pt.fetch_page(session, 4)


def test_fetch_page_rejects_wrong_locale_response(tmp_path, monkeypatch, html_ka):
    monkeypatch.setattr(pt, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(pt, "PAGE_DELAY_SEC", 0)
    monkeypatch.setattr(pt, "RETRY_BACKOFF_SEC", 0)
    session = FlakySession(html_ka)
    with pytest.raises(RuntimeError, match="локал"):
        pt.fetch_page(session, 1)
    # Чужая локаль — не сетевой сбой: ретраить её нельзя, должен быть ровно один запрос.
    assert session.calls == 1
    # И в кэш её тоже писать нельзя — иначе следующий запуск подцепит чужой язык.
    assert pt.read_cached_page(1) is None
    assert not list(tmp_path.glob("page-1.html"))


def test_build_session_sets_locale_cookie():
    session = pt.build_session()
    assert "%22locale%22%3A%22ru%22" in session.headers["Cookie"]
    assert "autoshkola.ge" in session.headers["User-Agent"]


def test_build_document_sorts_by_id_and_fills_meta():
    tickets = [make_ticket(id=9), make_ticket(id=2)]
    document = pt.build_document(tickets, total=2)
    assert [t["id"] for t in document["tickets"]] == [2, 9]
    assert document["meta"]["category_id"] == 2
    assert document["meta"]["categories"] == ["B", "B1"]
    assert document["meta"]["lang"] == "ru"
    assert document["meta"]["total"] == 2
    # Спека требует ISO 8601 именно с часовым поясом: проверка на "начинается с 20"
    # пропустила бы наивное время без смещения.
    parsed_at = document["meta"]["parsed_at"]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}", parsed_at)


def test_build_document_drops_internal_image_url_field():
    tickets = [make_ticket(image_url="https://example.com/a.jpg", image="tickets/images/a.jpg")]
    document = pt.build_document(tickets, total=1)
    assert "image_url" not in document["tickets"][0]
    assert document["tickets"][0]["image"] == "tickets/images/a.jpg"


def test_write_output_creates_file(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    pt.write_output({"meta": {"total": 1}, "tickets": [make_ticket()]})
    import json as json_module

    written = json_module.loads(target.read_text(encoding="utf-8"))
    assert written["tickets"][0]["question"] == "Вопрос"


def test_write_output_replaces_atomically_without_temp_leftovers(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    target.write_text('{"старое": true}', encoding="utf-8")
    pt.write_output({"meta": {}, "tickets": []})
    assert [p.name for p in tmp_path.iterdir()] == ["tickets-b-ru.json"]
    assert "старое" not in target.read_text(encoding="utf-8")


def test_write_output_uses_atomic_replace(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    calls = []
    real_replace = pt.os.replace

    def spy_replace(src, dst):
        calls.append((str(src), str(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr(pt.os, "replace", spy_replace)
    pt.write_output({"meta": {}, "tickets": []})
    assert len(calls) == 1
    src, dst = calls[0]
    assert src.endswith(".json.tmp")
    assert dst.endswith("tickets-b-ru.json")


def test_write_output_cleans_up_tmp_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)

    def failing_replace(src, dst):
        raise OSError("диск полон")

    monkeypatch.setattr(pt.os, "replace", failing_replace)
    with pytest.raises(OSError):
        pt.write_output({"meta": {}, "tickets": []})
    assert not list(tmp_path.glob("*.tmp"))


def test_main_keeps_old_database_when_validation_fails(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    target.write_text('{"старое": true}', encoding="utf-8")
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    monkeypatch.setattr(pt, "build_session", lambda: object())
    broken = [make_ticket(id=1), make_ticket(id=1)]  # дубль id — база невалидна
    monkeypatch.setattr(
        pt, "collect", lambda session, refresh=False: (broken, 2, {1: 2}, 1)
    )
    assert pt.main([]) == 1
    assert target.read_text(encoding="utf-8") == '{"старое": true}'
    assert not list(tmp_path.glob("*.tmp"))


def test_main_writes_new_database_when_validation_passes(tmp_path, monkeypatch):
    target = tmp_path / "tickets-b-ru.json"
    monkeypatch.setattr(pt, "OUTPUT_JSON", target)
    monkeypatch.setattr(pt, "build_session", lambda: object())
    good = [make_ticket(id=1), make_ticket(id=2)]
    monkeypatch.setattr(
        pt, "collect", lambda session, refresh=False: (good, 2, {1: 2}, 1)
    )
    assert pt.main([]) == 0
    import json as json_module

    written = json_module.loads(target.read_text(encoding="utf-8"))
    assert [t["id"] for t in written["tickets"]] == [1, 2]
