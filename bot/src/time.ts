// В D1 всё время — UTC строкой SQLite "YYYY-MM-DD HH:MM:SS"; показываем в Asia/Tbilisi
export function formatTbilisi(sqliteUtc: string): string {
  const date = new Date(sqliteUtc.replace(" ", "T") + "Z");
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tbilisi",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // Собираем строку из частей вручную, чтобы не зависеть от порядка/разделителей,
  // которые Intl.DateTimeFormat может менять между версиями ICU.
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`;
}
