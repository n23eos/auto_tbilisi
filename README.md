# Автошкола на русском языке — Тбилиси

**Avtoshkola.ge is the site of a Russian-language driving school in Tbilisi, together with the Telegram bot that takes its leads.** The landing page covers the course program, FAQ, contacts and a callback form that posts through FormSubmit. The practice section offers 898 Russian questions, including 51 locally translated eco-driving questions, with topics, search, favorites and review sessions. Full coverage of the current official bank has not been verified. Progress is kept in localStorage. The bot runs on Cloudflare Workers with data in D1, alerts admins when it fails and drops applications older than 180 days. Plain HTML, CSS and JavaScript with no bundler, hosted on GitHub Pages.

<div align="center">

[![Star on GitHub](https://img.shields.io/github/stars/n23eos/auto_tbilisi?style=for-the-badge&logo=github&label=Star%20this%20repo&color=FFD700&labelColor=1a1a1a)](https://github.com/n23eos/auto_tbilisi)

</div>

**Live:** https://avtoshkola.ge

## Стек

Чистый HTML + CSS + JS, без сборщиков. Хостинг — GitHub Pages.

- `index.html` — вся страница
- `css/tokens.css` — дизайн-токены (цвета OKLCH, шрифты, отступы, анимации)
- `css/style.css` — стили
- `js/main.js` — валидация и отправка формы

## Форма «Заказать звонок»

Заявки уходят через [FormSubmit.co](https://formsubmit.co) на `info@avtoshkola.ge` (пересылка ImprovMX на Gmail).

**Важно (один раз):** после первой заявки FormSubmit пришлёт на эту почту письмо
с кнопкой активации — нужно нажать «Activate», иначе заявки не будут доходить.

Сменить почту: заменить адрес в `js/main.js` (строка с `formsubmit.co/ajax/...`)
и в `index.html` (атрибут `action` формы).

Адреса домена: `info@` — для клиентов, `partners@` — для партнёров.
Пересылка настроена через ImprovMX (бесплатный тариф), записи MX ведут на mx1/mx2.improvmx.com.

## Тренировка и работа над ошибками

Страница `/bilety/trenirovka/`: 898 доступных вопросов на русском без таймера
и лимита ошибок. Есть поиск по номеру и словам, темы источника, избранное,
нерешённые, ошибки и короткие сессии на 10 или 20 вопросов.

- `js/training-logic.js` — прогресс, фильтры, навигация; без DOM, покрыто тестами;
- `js/training.js` — интерфейс.

Прогресс лежит в `localStorage` браузера под ключом `avtoshkola-progress-v1`:
решённые билеты, ошибки и позиция. Между устройствами не переносится, в приватном
окне не сохраняется — так и написано на самой странице. Если хранилище недоступно,
тренажёр работает без запоминания, а не падает.

Ошибки экзамена пишутся в тот же прогресс, поэтому после проваленной попытки
их сразу видно в разделе «мои ошибки».

Известные дефекты данных выписаны в [docs/tickets-known-issues.md](docs/tickets-known-issues.md).

## Тренажёр «Билеты ПДД»

Страница `/bilety/` — экзамен по правилам настоящего: 30 случайных вопросов, 30 минут,
допустимо не больше пяти ошибок. На шестой ошибке или по истечении времени экзамен
останавливается, дальше идёт разбор ошибок с картинками.

- `js/exam-logic.js` — правила экзамена без обращений к DOM, покрыты тестами;
- `js/exam.js` — интерфейс, таймер, отрисовка;
- `css/exam.css` — стили, значения берутся из `css/tokens.css`.

В выборку идут русские вопросы без пометки `withdrawn`: 898 из 921 после наложения переводов. Тесты логики:

```bash
npm test
```

## База билетов ПДД

`data/tickets-b-ru.json` — 921 билет категории B/B1 со страниц teoria.on.ge, картинки
в `data/tickets/images/`. Собирается парсером:

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements-dev.txt
.venv/bin/python -m tools.parse_tickets
```

Страницы кэшируются в `tools/.cache/` — повторный запуск не дёргает источник заново
(2-3 секунды вместо нескольких минут), `--refresh` кэш игнорирует. JSON перезаписывается
только если база прошла проверки: при любой проблеме скрипт печатает список претензий,
возвращает код 1 и оставляет прошлую базу нетронутой.

Число 898 и список предполагаемых изъятий получены из сторонних источников.
Официальный банк после авторизации пока не сверен. В
[data/withdrawn-tickets.json](data/withdrawn-tickets.json) 23 скрытых вопроса.
Публичный каталог imecadine.ge содержит ровно те же 898 ID из 921, что доступны
у нас после исключения. Поле `withdrawn` не является подтверждением
актуального официального статуса.

Темы: `data/ticket-topics.json`, обновление через `.venv/bin/python -m tools.import_ticket_topics`.
Импортёр проверяет полное покрытие ID локальной базы и отсутствие дублей.

У каждого билета есть поле `lang`. У 870 билетов это `ru`, у 51 (подкатегория
«эко-вождение», id 1742-1792) - `ka`: у источника русского перевода для них нет.
Наши переводы в `data/eco-ru-*.json` применяет `js/ticket-bank.js` при загрузке;
исходная база и индексы правильных ответов не меняются.

### Известная ошибка в данных источника

У билета `346` варианты 2 и 3 совпадают дословно. Это ошибка вёрстки на on.ge —
проверено по исходной странице, парсер воспроизводит её честно. Если билет попадёт
в тренажёр как есть, ученик увидит два одинаковых ответа.

Тесты парсера (сеть не нужна):

```bash
.venv/bin/python -m pytest tools/tests/ -v
```

Источник — [teoria.on.ge](https://teoria.on.ge). Вопросы взяты из официального экзамена
МВД Грузии, русский перевод и картинки — работа on.ge. **Перед публикацией раздела
на сайте проверить условия использования и при необходимости запросить разрешение.**

## Проверки перед коммитом

```bash
npm test                                   # логика экзамена и тренировки
cd bot && npm test && npm run typecheck    # бот
.venv/bin/python -m pytest tools -q        # инструменты сборки данных
```

Те же три набора гоняются автоматически на push и pull request —
`.github/workflows/ci.yml`.

## Служебные файлы, которые не пишутся руками

`llms-full.txt` и даты в `sitemap.xml` собираются из содержимого сайта и
истории git, чтобы не расходиться с ним:

```bash
.venv/bin/python tools/build_llms_full.py
.venv/bin/python tools/update_sitemap.py
```

## Запуск локально

```bash
python3 -m http.server 8765
```

и открыть http://localhost:8765

## Контакты школы (данные со страницы Facebook)

- Телефон: +995 599 98 77 07
- Адрес: пр-т Важа Пшавела 9, Тбилиси
- Facebook: https://www.facebook.com/avtoshkolatbilisi

## Домен

Сайт открывается по адресу https://avtoshkola.ge (домен зарегистрирован у cleannet.ge).

DNS-записи домена:

| Тип | Имя | Значение |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | n23eos.github.io. |

Файл `CNAME` в корне репозитория создан GitHub — удалять его нельзя,
иначе домен отвяжется. Если статический генератор или force-push затрёт его,
домен придётся подключать заново.
