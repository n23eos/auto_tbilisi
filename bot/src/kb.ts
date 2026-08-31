import { KB_SECTIONS, type KbSection } from "./generated/kb";

// Контакты стабильны годами — константа, а не парсинг txt
export const CONTACTS = [
  "📞 <b>Контакты автошколы</b>",
  "",
  "Телефон: +995 599 98 77 07 (звонки 10:00–20:00)",
  "WhatsApp: wa.me/995599987707 (писать можно круглосуточно)",
  "Почта: info@avtoshkola.ge",
  "Аудитория: пр-т Важа Пшавела 9 (метро «Медицинский университет»)",
  "Площадка: у метро «Церетели»",
  "Сайт: avtoshkola.ge",
].join("\n");

const MENU_TO_SECTION: Record<string, string> = {
  ceny: "ceny",
  dokumenty: "dokumenty",
  ekzameny: "ekzameny",
};

export function menuAnswer(menuId: string): string {
  const sectionId = MENU_TO_SECTION[menuId];
  const section = KB_SECTIONS.find((s) => s.id === sectionId);
  if (!section) throw new Error(`Нет раздела для меню ${menuId}`);
  return section.text;
}

// --- Поиск по ключевым словам --------------------------------------------
//
// "fakty" (быстрые факты) — шпаргалка, которая ДУБЛИРУЕТ цены, документы,
// экзамены и права в сжатом виде. Наивный подсчёт совпадений слов почти
// всегда выбирал бы именно её — там есть понемногу от каждой темы. Это плохо
// для пользователя: вместо конкретного ответа он получал бы одну большую
// простыню. Поэтому "fakty" исключён из корпуса ПОИСКА, но остаётся в
// KB_SECTIONS — будущий AI-слой сможет использовать всю базу целиком.
const SEARCH_SECTIONS = KB_SECTIONS.filter((s) => s.id !== "fakty");

const MIN_WORD_LENGTH = 4;
// Длина "стема" — грубая замена полноценного стеммера для русского языка:
// сравниваем первые 4 буквы слова, а не слово целиком. Это гасит различия по
// падежам/числам ("документы" / "документов" → один стем "доку"), и при этом
// не даёт ложных совпадений через простой substring-поиск: слово "стоит"
// не должно матчить "СОстоит" — а по первым 4 буквам "сост" ≠ "стои".
const STEM_LENGTH = 4;

function extractWords(text: string): string[] {
  return text.toLowerCase().match(/[а-яёa-z]+/gi) ?? [];
}

function stem(word: string): string {
  return word.length <= STEM_LENGTH ? word : word.slice(0, STEM_LENGTH);
}

// Живая речь про деньги ("сколько стоит", "во сколько обойдётся") и то, как
// цены записаны в базе ("Цена: 150 ₾", "оплата после урока") — разная лексика
// об одном и том же понятии. Без этой связки раздел "Цены и оплата" ни разу
// не матчился бы по самому частому вопросу учеников. Список сознательно
// маленький и предметный, а не общий тезаурус синонимов.
const SYNONYM_GROUPS: string[][] = [["стои", "цена", "плат", "опла"]];

function synonymGroupOf(st: string): string[] {
  return SYNONYM_GROUPS.find((group) => group.includes(st)) ?? [st];
}

interface SectionIndex {
  section: KbSection;
  /** Частота стема в тексте раздела. */
  stemFreq: Map<string, number>;
}

const INDEX: SectionIndex[] = SEARCH_SECTIONS.map((section) => {
  const stemFreq = new Map<string, number>();
  for (const word of extractWords(section.text)) {
    if (word.length < MIN_WORD_LENGTH) continue;
    const st = stem(word);
    stemFreq.set(st, (stemFreq.get(st) ?? 0) + 1);
  }
  return { section, stemFreq };
});

/** Сколько разделов корпуса вообще упоминают понятие (стем или его синонимы). */
function documentFrequency(st: string): number {
  const group = synonymGroupOf(st);
  return INDEX.filter((idx) => group.some((g) => idx.stemFreq.has(g))).length;
}

/** IDF: редкие по корпусу слова весят больше частых — они различают разделы. */
function idf(st: string): number {
  const df = documentFrequency(st);
  if (df === 0) return 0;
  return Math.log((INDEX.length + 1) / (df + 1)) + 1;
}

/** Суммарная частота понятия (стем + синонимы) в разделе. */
function conceptFrequency(idx: SectionIndex, st: string): number {
  const group = synonymGroupOf(st);
  return group.reduce((sum, g) => sum + (idx.stemFreq.get(g) ?? 0), 0);
}

// Порог принятия результата. Раздел должен явно выделяться, а не просто
// случайно зацепить один общеупотребимый стем (см. тест на нерелевантный
// вопрос — там счёт остаётся близко к нулю).
const MIN_SCORE = 2;

/**
 * Поиск раздела по словам вопроса.
 * Скор раздела — сумма по словам вопроса: idf(слово) * log(1 + частота слова
 * в разделе). IDF отсеивает общие для всей базы слова ("сколько", "теория"),
 * логарифм частоты — отдаёт предпочтение разделу, где тема встречается часто
 * (то есть разделу ПРО это), а не разделу, где слово мелькнуло один раз мимоходом.
 */
export function searchKb(query: string): KbSection | null {
  const queryStems = [
    ...new Set(
      extractWords(query)
        .filter((w) => w.length >= MIN_WORD_LENGTH)
        .map(stem),
    ),
  ];
  if (queryStems.length === 0) return null;

  let best: KbSection | null = null;
  let bestScore = 0;
  for (const idx of INDEX) {
    let score = 0;
    for (const st of queryStems) {
      const freq = conceptFrequency(idx, st);
      if (freq === 0) continue;
      score += idf(st) * Math.log(1 + freq);
    }
    if (score > bestScore) {
      bestScore = score;
      best = idx.section;
    }
  }
  return bestScore >= MIN_SCORE ? best : null;
}
