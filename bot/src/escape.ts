// Для parse_mode: "HTML" Telegram требует экранировать только & < >
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
