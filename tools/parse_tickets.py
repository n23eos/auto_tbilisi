"""Парсер экзаменационных билетов ПДД Грузии (категория B/B1, русский язык).

Источник: https://teoria.on.ge
Спека: docs/superpowers/specs/2026-08-26-pdd-tickets-db-design.md

Скрипт намеренно ограничен одной категорией и одним языком: значения ниже —
константы, из них выводятся URL, cookie, имя JSON и путь к картинкам.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from PIL import Image

# --- Что парсим (менять здесь, а не по всему файлу) ---
CATEGORY_ID = 2
CATEGORY_LABELS = ["B", "B1"]
LOCALE = "ru"

BASE_URL = "https://teoria.on.ge"
LIST_URL = f"{BASE_URL}/tickets/{CATEGORY_ID}"

TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = TOOLS_DIR.parent
DATA_DIR = ROOT_DIR / "data"
IMAGES_DIR = DATA_DIR / "tickets" / "images"
OUTPUT_JSON = DATA_DIR / f"tickets-{CATEGORY_LABELS[0].lower()}-{LOCALE}.json"
CACHE_DIR = TOOLS_DIR / ".cache" / f"category-{CATEGORY_ID}" / LOCALE

# Признаки того, что страница отдана в нужном языке и нужной категории.
LOCALE_MARKER = f"locale-{LOCALE}"
CATEGORY_MARKER = f'data-active="/tickets/{CATEGORY_ID}"'

# В заголовке страницы общее число билетов идёт после грузинского слова "სულ" (всего).
TOTAL_RE = re.compile(r"სულ\s+(\d+)")

REQUEST_TIMEOUT_SEC = 30

PAGE_DELAY_SEC = 0.7
HTTP_RETRIES = 3
RETRY_BACKOFF_SEC = 2
USER_AGENT = "autoshkola.ge tickets parser (+https://avtoshkola.ge)"


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


def is_page_html_valid(html):
    """Страница непустая, отдана в нужной локали и относится к нужной категории."""
    if not html or not html.strip():
        return False
    return LOCALE_MARKER in html and CATEGORY_MARKER in html


def _cache_path(page):
    return CACHE_DIR / f"page-{page}.html"


def read_cached_page(page):
    """HTML из кэша, либо None, если кэша нет или он негодный."""
    path = _cache_path(page)
    if not path.exists():
        return None
    html = path.read_text(encoding="utf-8")
    return html if is_page_html_valid(html) else None


def write_cached_page(page, html):
    """Записать страницу в кэш атомарно — оборванная запись не оставит битый файл."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(page)
    tmp = path.with_suffix(".html.tmp")
    try:
        tmp.write_text(html, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        # os.replace переименовал файл — тогда tmp уже нет; если упали раньше, убираем мусор.
        tmp.unlink(missing_ok=True)


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
    """Список ответов и индексы всех помеченных правильными.

    Индексов может быть не один: у источника встречается разметка с двумя
    метками, и такой билет должен быть отбракован, а не молча принят.
    """
    answers = []
    correct_indexes = []
    for paragraph in article.select("p.t-answer"):
        # Пустые слоты (в разметке их всегда 4) помечены классом ans-empty.
        if "ans-empty" in paragraph.get("class", []):
            continue
        if paragraph.get("data-is-correct-list") == "true":
            correct_indexes.append(len(answers))
        answers.append(_clean_text(paragraph.select_one(".t-a-text")))
    return answers, correct_indexes


def parse_tickets(html, page_url):
    """Разобрать страницу списка в список билетов.

    Ничего не отбраковывает: билет с проблемой (нет id, пустой вопрос, нет метки
    правильного ответа) всё равно попадает в результат, чтобы валидатор о нём сообщил.
    """
    soup = BeautifulSoup(html, "html.parser")
    tickets = []
    for article in soup.select("article.ticket-container"):
        ticket_id = _parse_ticket_id(article)
        answers, correct_indexes = _parse_answers(article)
        correct = correct_indexes[0] if len(correct_indexes) == 1 else None
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


MIN_ANSWERS = 2


def _validate_ticket(ticket):
    """Ошибки одного билета. Пустой список = билет годный."""
    errors = []
    ticket_id = ticket["id"]
    if not isinstance(ticket_id, int) or isinstance(ticket_id, bool) or ticket_id <= 0:
        return [f"билет {ticket_id!r}: id должен быть положительным целым"]

    if not ticket["question"]:
        errors.append(f"билет {ticket_id}: пустой текст вопроса")

    answers = ticket["answers"]
    if len(answers) < MIN_ANSWERS:
        errors.append(f"билет {ticket_id}: меньше {MIN_ANSWERS} ответов")
    if any(not answer for answer in answers):
        errors.append(f"билет {ticket_id}: есть пустой ответ")

    correct = ticket["correct"]
    is_int = isinstance(correct, int) and not isinstance(correct, bool)
    if not is_int or not 0 <= correct < len(answers):
        errors.append(f"билет {ticket_id}: правильный ответ не определён ({correct!r})")

    # image_url есть, а локального файла нет — картинку потеряли, база неполная.
    if ticket["image_url"] and not ticket["image"]:
        errors.append(f"билет {ticket_id}: картинка есть у источника, но не скачана")

    return errors


def validate(tickets, total, pages_seen, page_count):
    """Проверить собранную базу. Возвращает список сообщений об ошибках.

    pages_seen — {номер страницы: сколько билетов с неё разобрано}.
    """
    errors = []

    if len(tickets) != total:
        errors.append(
            f"разобрано {len(tickets)} билетов, источник заявляет {total}"
        )

    counted_on_pages = sum(pages_seen.values())
    if counted_on_pages != total:
        errors.append(
            f"со страниц собрано {counted_on_pages} билетов, источник заявляет {total}"
        )

    missing_pages = [n for n in range(1, page_count + 1) if n not in pages_seen]
    if missing_pages:
        errors.append(f"не обработаны страниц: {missing_pages}")

    empty_pages = [n for n, count in sorted(pages_seen.items()) if count == 0]
    if empty_pages:
        errors.append(f"пустые страницы (ноль билетов): {empty_pages}")

    seen_ids = set()
    duplicates = set()
    for ticket in tickets:
        ticket_id = ticket["id"]
        if ticket_id in seen_ids:
            duplicates.add(ticket_id)
        seen_ids.add(ticket_id)
        errors.extend(_validate_ticket(ticket))

    if duplicates:
        errors.append(f"дублирующиеся id: {sorted(duplicates)}")

    return errors


def verify_image(path):
    """Файл действительно декодируется как изображение.

    verify() ловит битую структуру, но не всегда — обрыв файла, поэтому следом
    открываем заново и делаем load(): у недокачанного JPEG заголовок цел,
    а данные — нет.
    """
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
        return True
    except Exception:
        return False


def download_image(session, url, dest):
    """Скачать картинку в dest. True — на диске лежит проверенное изображение.

    Уже лежащий файл повторно не качаем, но проверяем: Content-Type для него
    взять неоткуда, поэтому единственная проверка — декодирование.
    """
    if dest.exists():
        if verify_image(dest):
            return True
        dest.unlink()  # мусор с прошлого запуска — качаем заново

    try:
        response = session.get(url, timeout=REQUEST_TIMEOUT_SEC)
        response.raise_for_status()
    except Exception:
        return False

    content_type = response.headers.get("Content-Type", "")
    if not content_type.startswith("image/"):
        return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        tmp.write_bytes(response.content)
        if not verify_image(tmp):
            return False
        os.replace(tmp, dest)
        return True
    finally:
        # os.replace переименовал файл — тогда tmp уже нет; если упали раньше, убираем мусор.
        tmp.unlink(missing_ok=True)


def build_session():
    """HTTP-сессия с cookie нужного языка.

    Источник переключает язык только на полный объект настроек: неполный
    (без category/skin/user) локаль не меняет — проверено вручную.
    """
    settings = {"category": CATEGORY_ID, "locale": LOCALE, "skin": "dark", "user": 0}
    cookie_value = quote(json.dumps(settings, separators=(",", ":")), safe="")
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Cookie": f"exam-settings={cookie_value}",
        }
    )
    return session


class WrongLocaleError(RuntimeError):
    """Ответ пришёл в чужой локали/категории — не ретраится и не кэшируется."""


def fetch_page(session, page, refresh=False):
    """HTML страницы списка: из кэша, либо из сети с ретраями.

    Ответ в чужой локали/категории — это ошибка, а не повод писать его в кэш.
    Отдельный класс исключения нужен, чтобы отличать её от сетевых сбоев:
    оба вида ошибок могут прийти как RuntimeError (в т.ч. от самой сессии),
    но ретраить можно только сетевые.
    """
    if not refresh:
        cached = read_cached_page(page)
        if cached is not None:
            return cached

    last_error = None
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            response = session.get(
                LIST_URL, params={"page": page}, timeout=REQUEST_TIMEOUT_SEC
            )
            response.raise_for_status()
            html = response.content.decode("utf-8", errors="replace")
            if not is_page_html_valid(html):
                raise WrongLocaleError(
                    f"страница {page}: ответ не в локали {LOCALE} "
                    f"или не категория {CATEGORY_ID}"
                )
            write_cached_page(page, html)
            time.sleep(PAGE_DELAY_SEC)
            return html
        except WrongLocaleError:
            raise
        except Exception as error:
            last_error = error
            time.sleep(RETRY_BACKOFF_SEC * attempt)

    raise RuntimeError(f"страница {page}: не удалось скачать за {HTTP_RETRIES} попыток ({last_error})")


TICKET_FIELDS = ("id", "question", "image", "answers", "correct", "source")


def build_document(tickets, total):
    """Итоговый JSON-документ: meta + билеты, отсортированные по id.

    Порядок стабильный, чтобы diff в git был читаемым. Побайтово файл между
    прогонами не совпадёт — parsed_at меняется.
    """
    return {
        "meta": {
            "category_id": CATEGORY_ID,
            "categories": CATEGORY_LABELS,
            "lang": LOCALE,
            "source": LIST_URL,
            "parsed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "total": total,
        },
        "tickets": [
            {field: ticket.get(field) for field in TICKET_FIELDS}
            for ticket in sorted(tickets, key=lambda t: t["id"])
        ],
    }


def write_output(document):
    """Атомарно записать JSON: провалившаяся запись не портит прошлый результат."""
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT_JSON.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, OUTPUT_JSON)


def collect(session, refresh=False):
    """Обойти все страницы, скачать картинки.

    Возвращает (билеты, total, pages_seen, page_count). page_count возвращаем явно:
    выводить его из pages_seen нельзя — тогда пропущенная страница сама себя спрячет.
    """
    first_page = fetch_page(session, 1, refresh=refresh)
    total = parse_total(first_page)
    page_count = parse_page_count(first_page)
    print(f"Источник заявляет: {total} билетов, {page_count} страниц")

    tickets = []
    pages_seen = {}
    for page in range(1, page_count + 1):
        html = first_page if page == 1 else fetch_page(session, page, refresh=refresh)
        page_tickets = parse_tickets(html, f"{LIST_URL}?page={page}")
        pages_seen[page] = len(page_tickets)
        tickets.extend(page_tickets)
        print(f"  страница {page}/{page_count}: {len(page_tickets)} билетов")

    for ticket in tickets:
        ticket["image"] = None
        if not ticket["image_url"]:
            continue
        # Имя берём из пути URL, а не из хвоста строки: query-параметр
        # превратился бы в часть имени файла.
        filename = Path(urlparse(ticket["image_url"]).path).name
        dest = IMAGES_DIR / filename
        if download_image(session, ticket["image_url"], dest):
            ticket["image"] = str(dest.relative_to(DATA_DIR))
        else:
            print(f"  ! билет {ticket['id']}: картинка не скачалась ({ticket['image_url']})")

    return tickets, total, pages_seen, page_count


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Парсер билетов ПДД Грузии (категория B/B1, русский)"
    )
    parser.add_argument(
        "--refresh", action="store_true", help="игнорировать кэш и перекачать страницы"
    )
    args = parser.parse_args(argv)

    session = build_session()
    tickets, total, pages_seen, page_count = collect(session, refresh=args.refresh)

    errors = validate(tickets, total, pages_seen, page_count)
    if errors:
        print(f"\nБаза невалидна, найдено проблем: {len(errors)}", file=sys.stderr)
        for error in errors[:50]:
            print(f"  - {error}", file=sys.stderr)
        if len(errors) > 50:
            print(f"  ... и ещё {len(errors) - 50}", file=sys.stderr)
        print(f"\n{OUTPUT_JSON} НЕ перезаписан.", file=sys.stderr)
        return 1

    write_output(build_document(tickets, total))
    with_images = sum(1 for t in tickets if t["image"])
    print(f"\nГотово: {len(tickets)} билетов ({with_images} с картинками) → {OUTPUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
