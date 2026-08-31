// Генерирует src/generated/kb.ts из плоских txt базы знаний.
// Запуск: npm run build-kb (из каталога bot/). Артефакт коммитится в git.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, "baza-znaniy", "dlya-bota");

const SECTIONS = [
  { id: "o-shkole", title: "О школе", file: "00-o-shkole.txt" },
  { id: "obuchenie", title: "Обучение", file: "01-obuchenie.txt" },
  { id: "ceny", title: "Цены и оплата", file: "02-ceny-i-oplata.txt" },
  { id: "dokumenty", title: "Документы и допуск", file: "03-dokumenty-i-dopusk.txt" },
  { id: "ekzameny", title: "Экзамены", file: "04-ekzameny.txt" },
  { id: "prava", title: "Права", file: "05-prava.txt" },
  { id: "fakty", title: "Быстрые факты", file: "06-bystrye-fakty.txt" },
];

// Источники начинаются со служебного баннера вида:
//   ============================================================
//   ТЕМА: <заголовок>
//   ============================================================
// Заголовок уже хранится отдельно в SECTIONS[].title, так что этот баннер —
// чистый файловый мусор для пользователя Telegram: строки из "=" и техническую
// метку "ТЕМА:" бот никогда не должен показывать как часть ответа. Срезаем его.
const BANNER_RE = /^=+\nТЕМА:.*\n=+\n+/;

const sections = SECTIONS.map((s) => {
  const raw = readFileSync(join(src, s.file), "utf8").trim();
  const text = raw.replace(BANNER_RE, "").trim();
  return { ...s, text };
});

const out = `// АВТОГЕНЕРАЦИЯ: npm run build-kb. Не править руками — источник baza-znaniy/dlya-bota/.
export interface KbSection { id: string; title: string; text: string }
export const KB_SECTIONS: KbSection[] = ${JSON.stringify(
  sections.map(({ id, title, text }) => ({ id, title, text })),
  null,
  2,
)};
`;

mkdirSync(join(root, "bot", "src", "generated"), { recursive: true });
writeFileSync(join(root, "bot", "src", "generated", "kb.ts"), out);
console.log(`kb.ts: ${sections.length} разделов, ${out.length} байт`);
