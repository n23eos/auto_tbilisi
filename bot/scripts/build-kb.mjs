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

// Бот отправляет тексты разделов с parse_mode: "HTML". В базе знаний нет и не
// предполагается разметки — это простой текст, который пишут сотрудники школы.
// Но один «&» («теория & практика»), один «<» («< 18 лет») или один адрес в
// угловых скобках («<info@avtoshkola.ge>») заставит Telegram ответить 400, и
// ученик по этой кнопке меню не получит НИЧЕГО — молча и навсегда, потому что
// апдейт к тому моменту уже помечен обработанным и не повторится.
// Экранируем на сборке, а не на отправке: так в артефакт попадает ровно то,
// что уйдёт в Telegram, и проверить это можно тестом.
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const sections = SECTIONS.map((s) => {
  const raw = readFileSync(join(src, s.file), "utf8").trim();
  // Баннер срезаем ДО экранирования: иначе «=» не изменится, но порядок
  // операций станет неочевидным для следующего читателя.
  const text = escapeHtml(raw.replace(BANNER_RE, "").trim());
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
