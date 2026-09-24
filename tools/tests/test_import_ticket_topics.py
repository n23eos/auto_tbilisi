import json
from pathlib import Path

import pytest

from tools import import_ticket_topics as importer


TOPICS_HTML = """
<nav class="tickets-topics"><ul class="tickets-topics-list">
  <li><a href="/tickets/2/1" title="ქართული">1.ქართული</a></li>
  <li><a href="/tickets/2/2" title="ქართული 2">2.ქართული 2</a></li>
</ul></nav>
<select class="paginator-select"><option value="1">1</option><option value="2">2</option></select>
"""


def topic_page(ids, pages=1):
    options = "".join(f'<option value="{n}">{n}</option>' for n in range(1, pages + 1))
    articles = "".join(
        f'<article class="ticket-container"><div class="t-num">#{ticket_id}</div></article>'
        for ticket_id in ids
    )
    return f'<select class="paginator-select">{options}</select>{articles}'


def test_parse_topic_links_uses_source_ids_and_urls():
    assert importer.parse_topic_links(TOPICS_HTML) == [
        {"id": 1, "name": importer.TOPIC_NAMES[1], "source_url": "https://teoria.on.ge/tickets/2/1"},
        {"id": 2, "name": importer.TOPIC_NAMES[2], "source_url": "https://teoria.on.ge/tickets/2/2"},
    ]


def test_collect_topic_ids_follows_all_pages():
    pages = {
        "https://teoria.on.ge/tickets/2/1": topic_page([10], pages=2),
        "https://teoria.on.ge/tickets/2/1?page=2": topic_page([11]),
    }

    assert importer.collect_topic_ids(pages.__getitem__, pages["https://teoria.on.ge/tickets/2/1"], 1) == [10, 11]


def test_validate_mapping_requires_exact_local_coverage_and_no_duplicates():
    topics = [
        {"id": 1, "name": "Один", "source_url": "u1", "ticket_ids": [1, 2]},
        {"id": 2, "name": "Два", "source_url": "u2", "ticket_ids": [3]},
    ]
    importer.validate_mapping(topics, {1, 2, 3}, expected_total=3)

    with pytest.raises(ValueError, match="дубликат"):
        importer.validate_mapping(
            [{**topics[0], "ticket_ids": [1, 2]}, {**topics[1], "ticket_ids": [2]}],
            {1, 2},
            expected_total=2,
        )

    with pytest.raises(ValueError, match="покрытие"):
        importer.validate_mapping(topics, {1, 2, 3, 4}, expected_total=4)


def test_write_output_rejects_changed_existing_mapping(tmp_path):
    destination = tmp_path / "ticket-topics.json"
    old = {
        "meta": {"source": importer.LIST_URL},
        "topics": [{"id": 1, "name": "Один", "source_url": "u1", "ticket_ids": [1]}],
    }
    destination.write_text(json.dumps(old), encoding="utf-8")

    changed = {
        "meta": {"source": importer.LIST_URL},
        "topics": [{"id": 1, "name": "Изменено", "source_url": "u1", "ticket_ids": [1]}],
    }
    with pytest.raises(ValueError, match="изменился"):
        importer.write_output(changed, destination)
    assert json.loads(destination.read_text(encoding="utf-8")) == old


def test_committed_artifact_covers_local_ticket_database_exactly():
    root = Path(__file__).resolve().parents[2]
    artifact = json.loads((root / "data" / "ticket-topics.json").read_text(encoding="utf-8"))
    local = json.loads((root / "data" / "tickets-b-ru.json").read_text(encoding="utf-8"))
    topics = artifact["topics"]
    all_ids = [ticket_id for topic in topics for ticket_id in topic["ticket_ids"]]

    assert len(topics) == 32
    assert len(all_ids) == 921
    assert len(all_ids) == len(set(all_ids))
    assert set(all_ids) == {ticket["id"] for ticket in local["tickets"]}
    assert all(topic["source_url"].startswith("https://teoria.on.ge/tickets/2/") for topic in topics)
