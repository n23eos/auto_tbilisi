# Автошкола на русском языке — Тбилиси

Премиальный лендинг для автошколы: анимированный hero, программа обучения, FAQ, контакты и форма «Заказать звонок».

**Live:** https://n23eos.github.io/auto_tbilisi/

## Стек

Чистый HTML + CSS + JS, без сборщиков. Хостинг — GitHub Pages.

- `index.html` — вся страница
- `css/tokens.css` — дизайн-токены (цвета OKLCH, шрифты, отступы, анимации)
- `css/style.css` — стили
- `js/main.js` — валидация и отправка формы

## Форма «Заказать звонок»

Заявки уходят через [FormSubmit.co](https://formsubmit.co) на `revelmaat@yahoo.com`.

**Важно (один раз):** после первой заявки FormSubmit пришлёт на эту почту письмо
с кнопкой активации — нужно нажать «Activate», иначе заявки не будут доходить.

Сменить почту: заменить адрес в `js/main.js` (строка с `formsubmit.co/ajax/...`)
и в `index.html` (атрибут `action` формы).

## Запуск локально

```bash
python3 -m http.server 8765
```

и открыть http://localhost:8765

## Контакты школы (данные со страницы Facebook)

- Телефон: +995 599 98 77 07
- Адрес: пр-т Важа Пшавела 9, Тбилиси
- Facebook: https://www.facebook.com/avtoshkolatbilisi
