# Обновление оформления и тренажёра — 6 сентября 2026

## Иллюстрация

Встроенный imagegen. Художественная иллюстрация Тбилиси, не фотография школы
и не схема учебного маршрута. Итоговый формат — 1774 × 887, ровно 2:1.

- Исходник: `media/tbilisi-wide.png`.
- Сайт: `media/tbilisi-wide.webp`, мобильная версия `media/tbilisi-wide-900.webp`.
- Сжатие WebP через cwebp, исходник сохранён. Lazy loading, srcset и явные размеры.

Исходный запрос:

> Create one premium editorial illustration asset for a Russian-language driving school website in Tbilisi. Landscape 3:2 composition. Stylized architectural travel-poster art, unmistakably illustration, not a photograph or a map. Recognizable Tbilisi hillside old town with balconied houses, Narikala silhouette, the curved glass Peace Bridge over the Mtkvari, and a winding foreground urban road. One small anonymous amber compact car, no logo or markings. Restrained warm ivory paper, deep graphite, ochre and amber palette to match website #f8f7f3 / #20232b / #efb33e, small muted sage accents. Sophisticated flat forms with subtle printed grain, architectural precision, beautiful negative space, no gradients or glossy 3D. Composition fills frame, city occupies upper two thirds, road sweeps through lower third. No people, no text, no letters, no numbers, no labels, no watermark. This is a decorative imagined city illustration, not an actual driving route. Save a high-resolution image.

Финальный запрос редактирования по просьбе пользователя:

> Edit this Tbilisi editorial illustration into a WIDE HORIZONTAL 2:1 aspect ratio image (width twice height, ideally 2048x1024). Preserve its detailed printed travel-poster style, ivory/graphite/ochre/amber palette and architectural character. Recompose or extend the scene horizontally, do not merely crop off the foreground car, road or hilltop. Keep the Tbilisi balconied hillside old town and fortress on the left, glass Peace Bridge and river on the right, sweeping road with the small amber car in foreground. Expand breathable space and riverside architecture towards the right. Keep all key elements visible. No text, no labels, no logos, no watermark. Deliver only the finished horizontal illustration.

## Сценарии и аналитика

- Успешная попытка → предложение практики.
- Ошибки / незавершённая попытка → предложение теории; таймаут получает отдельный текст.
- Свободная тренировка → необязательная консультация, без блокировки билетов.
- `from=exam|training` и `goal=theory|practice` передаются в форму по белому списку.
- `learning_entry`, `exam_start`, `exam_complete`, `learning_cta_click`,
  `learning_form_view`, `generate_lead` описывают путь к заявке.
- Имя, телефон, комментарий и текст вопросов в GA4 не отправляются.
- Событие `generate_lead` сохраняет существующую семантику ответа FormSubmit;
  оно само по себе не доказывает доставку письма администратору или оплату.

Изменения предназначены для существующего статического сайта GitHub Pages.
