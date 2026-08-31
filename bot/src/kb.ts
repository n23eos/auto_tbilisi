import { KB_SECTIONS, type KbSection } from "./generated/kb";

// Контакты стабильны годами — константа, а не парсинг txt
export const CONTACTS = [
  "📞 <b>Контакты автошколы</b>",
  "",
  "Телефон: +995 599 98 77 07 (звонки 10:00–20:00 ежедневно)",
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
// "fakty" (быстрые факты) — шпаргалка, которая дублирует цены, документы,
// экзамены и права в сжатом виде. При наивном подсчёте совпадений слов она
// иногда побеждает (замерено на 28 тестовых вопросах — 2 из 28), и в том
// числе именно на обязательном для этой задачи вопросе про цену теории в
// группе. Раздел с ответом на конкретный вопрос пользователю полезнее, чем
// шпаргалка сразу обо всём, поэтому "fakty" исключён из корпуса ПОИСКА — но
// остаётся в KB_SECTIONS: будущий AI-слой сможет использовать всю базу целиком.
const SEARCH_SECTIONS = KB_SECTIONS.filter((s) => s.id !== "fakty");

const MIN_WORD_LENGTH = 4;
// Длина "стема" — грубая замена полноценного стеммера для русского языка:
// сравниваем первые 4 буквы слова, а не слово целиком. Это гасит различия по
// падежам/числам ("документы" / "документов" → один стем "доку"), и при этом
// не даёт ложных совпадений через простой substring-поиск: слово "стоит"
// не должно матчить "СОстоит" — а по первым 4 буквам "сост" ≠ "стои".
const STEM_LENGTH = 4;

// Слова короче или равные STEM_LENGTH стем не режет (см. stem() ниже) — они
// и так уже "стем себя самого". Но у слова "цена" все падежные формы тоже
// ровно по 4 буквы ("цена"/"цены"/"цену"/...), и каждая осталась бы своим
// отдельным стемом — раздел "Цены и оплата" не находился бы по вопросу "какие
// цены на обучение". Явный список форм точнее, чем общее укорачивание стема
// до 3 букв: слепое правило "первые 3 буквы" задело бы "центр"/"центров"
// (раздел про экзамены) и "план"/"планшет" (раздел про обучение) — случайные
// совпадения не по теме денег.
const SHORT_WORD_OVERRIDES: Record<string, string> = {
  цена: "цен",
  цены: "цен",
  цену: "цен",
  цене: "цен",
  ценой: "цен",
  ценою: "цен",
  ценам: "цен",
  ценами: "цен",
  ценах: "цен",
};

function extractWords(text: string): string[] {
  return text.toLowerCase().match(/[а-яёa-z]+/gi) ?? [];
}

function stem(word: string): string {
  if (word in SHORT_WORD_OVERRIDES) return SHORT_WORD_OVERRIDES[word];
  return word.length <= STEM_LENGTH ? word : word.slice(0, STEM_LENGTH);
}

// Живая речь про деньги ("сколько стоит", "какие цены", "во сколько
// обойдётся") и то, как цены записаны в базе ("Цена: 150 ₾", "оплата после
// урока") — разная лексика об одном и том же понятии: в 02-ceny-i-oplata.txt
// слово "стоит" не встречается вообще, а "цена" — 20 раз. Без этой связки
// раздел "Цены и оплата" ни разу не матчился бы по самому частому вопросу
// учеников. Список сознательно маленький и предметный, а не общий тезаурус.
const SYNONYM_GROUPS: string[][] = [["стои", "цен", "плат", "опла"]];

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

/** Суммарная частота понятия (стем + его синонимы) в разделе. */
function conceptFrequency(idx: SectionIndex, st: string): number {
  return synonymGroupOf(st).reduce((sum, g) => sum + (idx.stemFreq.get(g) ?? 0), 0);
}

// Порог принятия результата: раздел должен набрать хотя бы пару совпадений,
// а не одно случайное слово (см. тест на вопрос не по теме — там совпадений
// вообще нет, счёт остаётся нулевым).
const MIN_SCORE = 2;

/**
 * Поиск раздела по словам вопроса: считаем суммарную частоту слов вопроса
 * (после стемминга и синонимов) в тексте каждого раздела и берём раздел с
 * максимальным счётом. Раздел, который реально ПРО тему вопроса, обычно
 * упоминает её слова много раз — а не один раз мимоходом, как соседние
 * разделы, — поэтому счёт по частоте разделяет их лучше, чем просто факт
 * совпадения хотя бы одного слова.
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
      score += conceptFrequency(idx, st);
    }
    if (score > bestScore) {
      bestScore = score;
      best = idx.section;
    }
  }
  return bestScore >= MIN_SCORE ? best : null;
}
