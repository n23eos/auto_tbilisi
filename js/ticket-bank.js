// Русские переводы храним отдельно: исходная база остаётся слепком teoria.on.ge.
const TRANSLATION_FILES = [
  "eco-ru-1742-1758.json",
  "eco-ru-1759-1775.json",
  "eco-ru-1776-1792.json",
];

export function applyRussianTranslations(tickets, translations) {
  const result = tickets.map((ticket) => {
    const translated = translations[ticket.id];
    if (!translated) return ticket;
    if (ticket.lang !== "ka" || !translated.question || !Array.isArray(translated.answers)
      || translated.answers.length !== ticket.answers.length
      || translated.answers.some((answer) => typeof answer !== "string" || !answer.trim())) {
      throw new Error(`неверный перевод билета ${ticket.id}`);
    }
    return { ...ticket, question: translated.question, answers: translated.answers, lang: "ru" };
  });
  const translatedCount = result.filter((ticket) => ticket.lang === "ru").length
    - tickets.filter((ticket) => ticket.lang === "ru").length;
  if (translatedCount !== 51 || Object.keys(translations).length !== 51) {
    throw new Error(`неполный перевод эко-вождения: ${translatedCount} из 51`);
  }
  return result;
}

export async function loadTicketBank(dataUrl) {
  const [bankResponse, ...translationResponses] = await Promise.all([
    fetch(dataUrl),
    ...TRANSLATION_FILES.map((file) => fetch(new URL(`../data/${file}`, import.meta.url))),
  ]);
  if (!bankResponse.ok || translationResponses.some((response) => !response.ok)) {
    throw new Error("не удалось загрузить базу или переводы");
  }
  const [bank, ...parts] = await Promise.all([
    bankResponse.json(),
    ...translationResponses.map((response) => response.json()),
  ]);
  const translations = Object.assign({}, ...parts);
  return applyRussianTranslations(bank.tickets, translations);
}
