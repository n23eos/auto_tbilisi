import re
from pathlib import Path

from tools import build_topic_pages as builder


ROOT = Path(__file__).resolve().parents[2]


def rendered_pages():
    return builder.build_pages(ROOT, write=False)


def page_html(slug):
    path = Path("bilety") / "temy" / slug / "index.html"
    return rendered_pages()[path]


def ticket_ids(html):
    return [int(value) for value in re.findall(r'data-ticket-id="(\d+)"', html)]


def test_committed_pages_match_deterministic_generator():
    first = rendered_pages()
    second = rendered_pages()

    assert first == second
    for path, expected in first.items():
        assert (ROOT / path).read_text(encoding="utf-8") == expected


def test_every_question_belongs_to_the_page_topics():
    _, topics = builder.load_data(ROOT)
    for page in builder.PAGES:
        expected = [
            ticket_id
            for topic_id in page.topic_ids
            for ticket_id in topics[topic_id]["ticket_ids"]
        ]
        actual = ticket_ids(page_html(page.slug))

        assert actual == expected
        assert len(actual) == len(set(actual))
        for topic_id in page.topic_ids:
            assert f'data-topic-section="{topic_id}"' in page_html(page.slug)


def test_question_and_topic_links_keep_the_selected_material():
    for page in builder.PAGES:
        html = page_html(page.slug)
        ids = ticket_ids(html)

        for ticket_id in ids:
            assert html.count(f'href="/bilety/trenirovka/?ticket={ticket_id}"') == 1
        for topic_id in page.topic_ids:
            assert f'href="/bilety/trenirovka/?topic={topic_id}"' in html

        assert 'href="/bilety/"' in html
        for other in builder.PAGES:
            if other.slug != page.slug:
                assert f'href="/bilety/temy/{other.slug}/"' in html


def test_signs_page_has_source_categories_and_explicit_primary_action():
    html = page_html("dorozhnye-znaki")
    _, topics = builder.load_data(ROOT)

    assert 'href="/bilety/trenirovka/?topic=3">Тренировать предупреждающие знаки</a>' in html
    assert "?topic=signs" not in html
    for topic_id in range(3, 10):
        assert f'id="topic-{topic_id}"' in html
        assert topics[topic_id]["name"] in html


def test_each_page_has_distinct_metadata_and_heading():
    html_pages = rendered_pages()
    titles = set()
    descriptions = set()
    headings = set()

    for page in builder.PAGES:
        html = html_pages[page.output]
        title = re.search(r"<title>([^<]+)</title>", html).group(1)
        description = re.search(r'<meta name="description" content="([^"]+)">', html).group(1)
        heading = re.search(r'<h1 class="exam__title">([^<]+)</h1>', html).group(1)

        assert f'<link rel="canonical" href="{page.url}">' in html
        assert title == page.title
        assert heading == page.heading
        titles.add(title)
        descriptions.add(description)
        headings.add(heading)

    assert len(titles) == len(builder.PAGES)
    assert len(descriptions) == len(builder.PAGES)
    assert len(headings) == len(builder.PAGES)


def test_static_cards_hide_answers_and_size_lazy_images():
    for html in rendered_pages().values():
        assert "data-correct" not in html
        assert "topic-question__answer" not in html
        for image in re.findall(r'<img class="topic-question__image"[^>]+>', html):
            assert 'width="800"' in image
            assert 'height="503"' in image
            assert 'loading="lazy"' in image


def test_editorial_source_has_no_typographic_dashes():
    source = Path(builder.__file__).read_text(encoding="utf-8")
    assert "\u2013" not in source
    assert "\u2014" not in source
