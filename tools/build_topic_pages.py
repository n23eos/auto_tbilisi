#!/usr/bin/env python3
"""Собирает три статические страницы тем из локального каталога билетов.

Запуск:  python3 tools/build_topic_pages.py

Правильные ответы намеренно не попадают в HTML. Страница помогает выбрать
материал, а проверка ответа остаётся в тренажёре.
"""

from dataclasses import dataclass
from html import escape
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TICKETS_PATH = ROOT / "data" / "tickets-b-ru.json"
TOPICS_PATH = ROOT / "data" / "ticket-topics.json"
TRANSLATION_PATHS = (
    ROOT / "data" / "eco-ru-1742-1758.json",
    ROOT / "data" / "eco-ru-1759-1775.json",
    ROOT / "data" / "eco-ru-1776-1792.json",
)


@dataclass(frozen=True)
class Page:
    slug: str
    topic_ids: tuple[int, ...]
    title: str
    description: str
    heading: str
    lead: str
    primary_topic_id: int
    primary_action: str

    @property
    def url(self):
        return f"https://avtoshkola.ge/bilety/temy/{self.slug}/"

    @property
    def output(self):
        return Path("bilety") / "temy" / self.slug / "index.html"


PAGES = (
    Page(
        slug="dorozhnye-znaki",
        topic_ids=(3, 4, 5, 6, 7, 8, 9),
        title="Дорожные знаки ПДД Грузии: вопросы категории B | Автошкола Тбилиси",
        description=(
            "189 вопросов по дорожным знакам ПДД Грузии на русском: "
            "предупреждающие, приоритета, запрещающие, предписывающие и другие категории."
        ),
        heading="Дорожные знаки ПДД Грузии",
        lead=(
            "Все 189 вопросов по семи категориям дорожных знаков. "
            "Выберите раздел, просмотрите формулировки и откройте тренировку."
        ),
        primary_topic_id=3,
        primary_action="Тренировать предупреждающие знаки",
    ),
    Page(
        slug="perekrestki",
        topic_ids=(20,),
        title="Проезд перекрёстков: вопросы ПДД Грузии | Автошкола Тбилиси",
        description=(
            "45 вопросов по теме проезда перекрёстков из каталога ПДД Грузии категории B/B1 "
            "на русском языке."
        ),
        heading="Проезд перекрёстков",
        lead=(
            "45 вопросов о проезде перекрёстков из русскоязычного каталога категории B/B1. "
            "Просмотрите задания или начните тренировку по теме."
        ),
        primary_topic_id=20,
        primary_action="Тренировать проезд перекрёстков",
    ),
    Page(
        slug="ostanovka-stoyanka",
        topic_ids=(19,),
        title="Остановка и стоянка: вопросы ПДД Грузии | Автошкола Тбилиси",
        description=(
            "41 вопрос по теме остановки и стоянки из каталога ПДД Грузии категории B/B1 "
            "на русском языке."
        ),
        heading="Остановка и стоянка",
        lead=(
            "41 вопрос об остановке и стоянке из русскоязычного каталога категории B/B1. "
            "Просмотрите задания или начните тренировку по теме."
        ),
        primary_topic_id=19,
        primary_action="Тренировать остановку и стоянку",
    ),
)


def load_data(root=ROOT):
    """Читает локальные источники и возвращает проверенные словари по ID."""
    tickets_data = json.loads((root / TICKETS_PATH.relative_to(ROOT)).read_text(encoding="utf-8"))
    topics_data = json.loads((root / TOPICS_PATH.relative_to(ROOT)).read_text(encoding="utf-8"))
    translations = {}
    for path in TRANSLATION_PATHS:
        translations.update(
            json.loads((root / path.relative_to(ROOT)).read_text(encoding="utf-8"))
        )

    tickets = {}
    for source in tickets_data["tickets"]:
        ticket = dict(source)
        translated = translations.get(str(ticket["id"]))
        if ticket.get("lang") == "ka" and translated:
            if len(translated.get("answers", ())) != len(ticket.get("answers", ())):
                raise ValueError(f"неверный перевод вопроса {ticket['id']}")
            ticket.update(
                question=translated["question"],
                answers=translated["answers"],
                lang="ru",
            )
        if ticket["id"] in tickets:
            raise ValueError(f"дубликат вопроса {ticket['id']}")
        tickets[ticket["id"]] = ticket

    topics = {topic["id"]: topic for topic in topics_data["topics"]}
    for page in PAGES:
        for topic_id in page.topic_ids:
            if topic_id not in topics:
                raise ValueError(f"нет темы {topic_id}")
            for ticket_id in topics[topic_id]["ticket_ids"]:
                if ticket_id not in tickets:
                    raise ValueError(f"в теме {topic_id} нет вопроса {ticket_id}")
                if tickets[ticket_id]["lang"] != "ru":
                    raise ValueError(f"вопрос {ticket_id} не переведён на русский")
    return tickets, topics


def learning_nav():
    return """    <nav class="learning-nav" aria-label="Учебные разделы">
      <a class="learning-nav__link" href="/bilety/"><span aria-hidden="true">▦</span>Все билеты</a>
      <a class="learning-nav__link" href="/bilety/voprosy/"><span aria-hidden="true">▤</span>Все вопросы</a>
      <a class="learning-nav__link" href="/bilety/trenirovka/"><span aria-hidden="true">▶</span>Тренировка</a>
      <a class="learning-nav__link" href="/bilety/ekzamen/"><span aria-hidden="true">◷</span>Экзамен</a>
    </nav>"""


def question_card(ticket, topic_id):
    ticket_id = ticket["id"]
    image = ""
    if ticket.get("image"):
        image = (
            f'        <img class="topic-question__image" src="/data/{escape(ticket["image"], quote=True)}" '
            f'alt="Иллюстрация к вопросу №{ticket_id}" width="800" height="503" '
            'loading="lazy" decoding="async">\n'
        )
    return f"""      <article class="topic-question" data-ticket-id="{ticket_id}" data-topic-id="{topic_id}">
{image}        <div class="topic-question__body">
          <p class="topic-question__number">Вопрос №{ticket_id}</p>
          <h3>{escape(ticket["question"])}</h3>
          <a class="topic-question__link" href="/bilety/trenirovka/?ticket={ticket_id}">Открыть вопрос в тренировке</a>
        </div>
      </article>"""


def question_word(count):
    if count % 100 in range(11, 15):
        return "вопросов"
    if count % 10 == 1:
        return "вопрос"
    if count % 10 in range(2, 5):
        return "вопроса"
    return "вопросов"


def topic_section(topic, tickets, *, show_heading):
    topic_id = topic["id"]
    cards = "\n".join(question_card(tickets[ticket_id], topic_id) for ticket_id in topic["ticket_ids"])
    if show_heading:
        heading = f"""    <div class="topic-section__head">
      <div>
        <p class="section-kicker">Категория {topic_id}</p>
        <h2 id="topic-{topic_id}">{escape(topic["name"])}</h2>
        <p>{len(topic["ticket_ids"])} {question_word(len(topic["ticket_ids"]))}</p>
      </div>
      <a class="exam__btn exam__btn--ghost" href="/bilety/trenirovka/?topic={topic_id}">Тренировать эту категорию</a>
    </div>
"""
    else:
        heading = f"""    <div class="topic-section__head">
      <div>
        <h2 id="topic-{topic_id}">Вопросы темы</h2>
        <p>{len(topic["ticket_ids"])} {question_word(len(topic["ticket_ids"]))}</p>
      </div>
    </div>
"""
    return f"""  <section class="topic-section" data-topic-section="{topic_id}" aria-labelledby="topic-{topic_id}">
{heading}    <div class="topic-questions">
{cards}
    </div>
  </section>"""


def topic_index(page, topics):
    if len(page.topic_ids) == 1:
        return ""
    links = "\n".join(
        f'      <a href="#topic-{topic_id}"><span>{escape(topics[topic_id]["name"])}</span>'
        f'<strong>{len(topics[topic_id]["ticket_ids"])}</strong></a>'
        for topic_id in page.topic_ids
    )
    return f"""  <nav class="topic-index" aria-label="Категории дорожных знаков">
    <h2>Категории знаков</h2>
    <div class="topic-index__links">
{links}
    </div>
  </nav>"""


def related_pages(page):
    links = "\n".join(
        f'      <a href="/bilety/temy/{other.slug}/">{escape(other.heading)}</a>'
        for other in PAGES
        if other.slug != page.slug
    )
    return f"""  <aside class="topic-related" aria-labelledby="related-title">
    <h2 id="related-title">Другие темы</h2>
    <div class="topic-related__links">
{links}
      <a href="/bilety/">Все билеты ПДД</a>
    </div>
  </aside>"""


def render_page(page, tickets, topics):
    count = sum(len(topics[topic_id]["ticket_ids"]) for topic_id in page.topic_ids)
    sections = "\n".join(
        topic_section(topics[topic_id], tickets, show_heading=len(page.topic_ids) > 1)
        for topic_id in page.topic_ids
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(page.title)}</title>
  <meta name="description" content="{escape(page.description, quote=True)}">
  <link rel="canonical" href="{page.url}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#faf9f6">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{escape(page.heading, quote=True)}">
  <meta property="og:description" content="{escape(page.description, quote=True)}">
  <meta property="og:url" content="{page.url}">
  <meta property="og:image" content="https://avtoshkola.ge/media/og-image.jpg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;900&amp;family=Golos+Text:wght@400;500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/tokens.css?v=23">
  <link rel="stylesheet" href="/css/style.css?v=31">
  <link rel="stylesheet" href="/css/exam.css?v=29">
  <link rel="stylesheet" href="/css/topics.css?v=1">
  <link rel="icon" href="/favicon.ico" sizes="any">
</head>
<body>
  <header class="nav is-solid">
    <a class="nav__brand" href="/" aria-label="Автошкола на русском языке в Тбилиси">Автошкола<span class="nav__brand-dot">·</span><span class="nav__brand-city">Тбилиси</span></a>
    <nav class="nav__links" aria-label="Разделы сайта">
      <a class="nav__link" href="/#prices">Цены</a>
      <a class="nav__link nav__tickets" href="/bilety/">Билеты ПДД</a>
      <a class="nav__link" href="/voprosy/">Частые вопросы</a>
      <a class="nav__link" href="/#contact">Контакты</a>
    </nav>
    <a class="nav__cta" href="tel:+995599987707" aria-label="Позвонить: +995 599 98 77 07">599 98 77 07</a>
  </header>
  <main class="exam topic-page">
{learning_nav()}
    <header class="topic-hero">
      <p class="section-kicker">Тематическая подборка</p>
      <h1 class="exam__title">{escape(page.heading)}</h1>
      <p class="exam__lead">{escape(page.lead)}</p>
      <div class="topic-hero__actions">
        <a class="exam__btn exam__btn--primary" href="/bilety/trenirovka/?topic={page.primary_topic_id}">{escape(page.primary_action)}</a>
        <a class="exam__btn exam__btn--ghost" href="#questions">Посмотреть {count} вопросов</a>
      </div>
      <p class="topic-guide">Сначала попробуйте ответить по формулировке и иллюстрации, затем откройте вопрос в тренировке. Правильные варианты здесь скрыты, чтобы не подсказывать ответ до попытки.</p>
    </header>
{topic_index(page, topics)}
  <div id="questions" class="topic-page__questions">
{sections}
  </div>
{related_pages(page)}
    <p class="exam__source">Вопросы взяты из каталога категории B/B1 на <a href="https://teoria.on.ge/tickets/2" rel="nofollow noopener" target="_blank">teoria.on.ge</a>. Это неофициальная учебная подборка автошколы. Соответствие актуальному официальному банку пока не подтверждено.</p>
  </main>
  <footer class="footer"><p class="footer__mark">Автошкола на русском языке</p><p class="footer__meta"><a href="/">На главную</a> · <a href="tel:+995599987707">+995 599 98 77 07</a></p></footer>
  <script src="/js/analytics.js?v=25" defer></script>
</body>
</html>
"""


def build_pages(root=ROOT, *, write=True):
    """Возвращает содержимое страниц и при обычном запуске обновляет их."""
    tickets, topics = load_data(root)
    rendered = {page.output: render_page(page, tickets, topics) for page in PAGES}
    if write:
        for relative_path, html in rendered.items():
            destination = root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(html, encoding="utf-8")
            print(f"{relative_path}: {html.count('data-ticket-id=')} вопросов")
    return rendered


if __name__ == "__main__":
    build_pages()
