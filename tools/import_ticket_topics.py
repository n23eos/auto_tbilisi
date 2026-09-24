"""Импорт тематической раскладки билетов с teoria.on.ge.

Источник остаётся владельцем списка тем и билетов. Локальные русские названия
нужны только интерфейсу, а IDs тем и билетов всегда берутся из его ссылок.
"""

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


BASE_URL = "https://teoria.on.ge"
CATEGORY_ID = 2
LIST_URL = f"{BASE_URL}/tickets/{CATEGORY_ID}"
ROOT_DIR = Path(__file__).resolve().parent.parent
LOCAL_TICKETS = ROOT_DIR / "data" / "tickets-b-ru.json"
OUTPUT_JSON = ROOT_DIR / "data" / "ticket-topics.json"
CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "topics" / f"category-{CATEGORY_ID}-ru"
REQUEST_TIMEOUT_SEC = 30
USER_AGENT = "autoshkola.ge ticket topics importer (+https://avtoshkola.ge)"

TOPIC_NAMES = {
    1: "Участники движения, знаки и конвенция",
    2: "Неисправности и условия управления",
    3: "Предупреждающие знаки",
    4: "Знаки приоритета",
    5: "Запрещающие знаки",
    6: "Предписывающие знаки",
    7: "Информационно-указательные знаки",
    8: "Знаки сервиса",
    9: "Знаки дополнительной информации",
    10: "Сигналы светофора",
    11: "Сигналы регулировщика",
    12: "Применение специальных сигналов",
    13: "Аварийная световая сигнализация",
    14: "Световые приборы и звуковой сигнал",
    15: "Движение, маневрирование и проезжая часть",
    16: "Обгон",
    17: "Скорость движения",
    18: "Тормозной путь и дистанция",
    19: "Остановка и стоянка",
    20: "Проезд перекрёстков",
    21: "Железнодорожный переезд",
    22: "Движение по автомагистрали",
    23: "Жилая зона и приоритет маршрутного транспорта",
    24: "Буксировка",
    25: "Учебная езда",
    26: "Перевозка людей и грузов",
    27: "Велосипеды, мопеды и перегон скота",
    28: "Дорожная разметка",
    29: "Медицинская помощь",
    30: "Безопасность движения",
    31: "Административное право",
    32: "Эко-вождение",
}


def build_session():
    settings = {"category": CATEGORY_ID, "locale": "ru", "skin": "dark", "user": 0}
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Cookie": "exam-settings=" + requests.utils.quote(json.dumps(settings, separators=(",", ":"))),
        }
    )
    return session


def parse_page_count(html):
    values = [int(value) for value in re.findall(r'<option[^>]+value="(\d+)"', html)]
    return max(values) if values else 1


def parse_topic_links(html, require_all=False):
    soup = BeautifulSoup(html, "html.parser")
    topics = []
    pattern = re.compile(rf"^/tickets/{CATEGORY_ID}/(\d+)$")
    for link in soup.select(".tickets-topics-list a[href]"):
        match = pattern.match(link["href"])
        if not match:
            continue
        topic_id = int(match.group(1))
        name = " ".join(link.get("title", link.get_text(" ", strip=True)).split())
        topics.append(
            {
                "id": topic_id,
                "name": TOPIC_NAMES.get(topic_id, name),
                "source_url": urljoin(BASE_URL, link["href"]),
            }
        )
    if len(topics) != len({topic["id"] for topic in topics}):
        raise ValueError("в ссылках источника есть дубликаты тем")
    if require_all and set(topic["id"] for topic in topics) != set(TOPIC_NAMES):
        raise ValueError("набор ссылок тем источника изменился или неполон")
    return sorted(topics, key=lambda topic: topic["id"])


def parse_ticket_ids(html):
    soup = BeautifulSoup(html, "html.parser")
    ids = []
    for number in soup.select("article.ticket-container .t-num"):
        raw = number.get_text(" ", strip=True).lstrip("#")
        if not raw.isdigit():
            raise ValueError(f"не распознан ID билета: {raw!r}")
        ids.append(int(raw))
    return ids


def collect_topic_ids(fetch, first_html, topic_id):
    """Собрать IDs одной темы, включая все страницы пагинации."""
    page_count = parse_page_count(first_html)
    ids = parse_ticket_ids(first_html)
    for page in range(2, page_count + 1):
        ids.extend(parse_ticket_ids(fetch(f"{LIST_URL}/{topic_id}?page={page}")))
    return ids


def validate_mapping(topics, local_ids, expected_total=921):
    all_ids = []
    for topic in topics:
        ids = topic["ticket_ids"]
        if ids != sorted(set(ids)):
            raise ValueError(f"тема {topic['id']}: дубликат или нестабильный порядок IDs")
        all_ids.extend(ids)
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("в mapping есть дубликат ID билета")
    if set(all_ids) != set(local_ids) or len(local_ids) != expected_total:
        raise ValueError(
            f"покрытие локальных билетов не совпадает: source={len(all_ids)}, local={len(local_ids)}"
        )


def _cache_path(url):
    parsed = urlparse(url)
    suffix = parsed.path.strip("/").replace("/", "-") or "root"
    if parsed.query:
        suffix += "-" + parsed.query.replace("=", "-")
    return CACHE_DIR / f"{suffix}.html"


def fetch_html(session, url, refresh=False):
    path = _cache_path(url)
    if path.exists() and not refresh:
        return path.read_text(encoding="utf-8")
    response = session.get(url, timeout=REQUEST_TIMEOUT_SEC)
    response.raise_for_status()
    html = response.content.decode("utf-8", errors="replace")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(html, encoding="utf-8")
    os.replace(temporary, path)
    return html


def load_local_ids():
    document = json.loads(LOCAL_TICKETS.read_text(encoding="utf-8"))
    return {ticket["id"] for ticket in document["tickets"]}


def _mapping_signature(document):
    return [
        {
            key: topic[key]
            for key in ("id", "name", "source_url", "ticket_ids")
        }
        for topic in document["topics"]
    ]


def write_output(document, destination=OUTPUT_JSON):
    if destination.exists():
        previous = json.loads(destination.read_text(encoding="utf-8"))
        if _mapping_signature(previous) != _mapping_signature(document):
            raise ValueError("существующий mapping изменился, файл не перезаписан")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, destination)


def _cached_checked_at(destination):
    if destination.exists():
        previous = json.loads(destination.read_text(encoding="utf-8"))
        checked_at = previous.get("meta", {}).get("checked_at")
        if checked_at:
            return checked_at
    cache_files = list(CACHE_DIR.glob("*.html"))
    if not cache_files:
        raise ValueError("cached режим требует существующий HTML-кэш")
    oldest = min(path.stat().st_mtime for path in cache_files)
    return datetime.fromtimestamp(oldest).astimezone().isoformat(timespec="seconds")


def import_topics(refresh=True, destination=OUTPUT_JSON):
    session = build_session()
    fetch = lambda url: fetch_html(session, url, refresh=refresh)
    topics = parse_topic_links(fetch(LIST_URL), require_all=True)
    for topic in topics:
        topic["ticket_ids"] = sorted(
            collect_topic_ids(fetch, fetch(topic["source_url"]), topic["id"])
        )
    validate_mapping(topics, load_local_ids())
    checked_at = (
        datetime.now().astimezone().isoformat(timespec="seconds")
        if refresh
        else _cached_checked_at(destination)
    )
    document = {
        "meta": {
            "source": LIST_URL,
            "category_id": CATEGORY_ID,
            "locale": "ru",
            "checked_at": checked_at,
            "total_topics": len(topics),
            "total_ticket_ids": sum(len(topic["ticket_ids"]) for topic in topics),
        },
        "topics": topics,
    }
    write_output(document, destination)
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="явно обновить HTML из источника")
    parser.add_argument("--cached", action="store_true", help="работать только с существующим HTML-кэшем")
    args = parser.parse_args()
    document = import_topics(refresh=not args.cached)
    print(f"Готово: {document['meta']['total_topics']} тем, {document['meta']['total_ticket_ids']} билетов")


if __name__ == "__main__":
    main()
