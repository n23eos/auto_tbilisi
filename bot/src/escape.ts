// Для parse_mode: "HTML" Telegram требует экранировать только & < >
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Экранирует текст и обрезает его до limit символов ГОТОВОЙ строки.
 *
 * Считать длину до экранирования нельзя: «&» превращается в «&amp;» (впятеро
 * длиннее), «<» — в «&lt;». Имя из 1100 символов «<» после экранирования даёт
 * 4400 — больше лимита Telegram в 4096, и карточка заявки не уходит вообще.
 *
 * Режем ИСХОДНЫЙ текст посимвольно, а не готовый: обрезка готовой строки
 * разрубила бы HTML-сущность пополам («&l»), и Telegram отверг бы сообщение.
 */
export function escapeClamped(text: string, limit: number): string {
  const escaped = escapeHtml(text);
  if (escaped.length <= limit) return escaped;
  // Экранирование только удлиняет строку, поэтому limit символов исходника —
  // заведомо достаточная верхняя граница, с которой начинать укорачивание.
  let cut = text.slice(0, limit);
  while (cut && escapeHtml(cut).length > limit - 1) cut = cut.slice(0, -1);
  return escapeHtml(cut) + "…";
}
