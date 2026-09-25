// Наборы привязаны к ID, чтобы прогресс не менял порядок учебных билетов.
export function buildTicketSets(tickets) {
  const ordered = tickets.filter(ticket => ticket.lang === "ru").slice().sort((a, b) => a.id - b.id);
  const sets = [];
  for (let start = 0; start < ordered.length; start += 30) {
    sets.push({ number: sets.length + 1, tickets: ordered.slice(start, start + 30) });
  }
  return sets;
}

export function questionStatus(ticket, progress) {
  if (progress.mistakes.includes(ticket.id)) return "Повторить";
  if (progress.solved.includes(ticket.id)) return "Решён";
  return "Не решён";
}

export function filterCatalog(tickets, { query = "", topicId = "", topics = [] } = {}) {
  const normalize = text => String(text).toLocaleLowerCase("ru").replaceAll("ё", "е");
  const search = normalize(query).trim();
  const topic = topicId ? topics.find(item => String(item.id) === String(topicId)) : null;
  const topicIds = topicId ? new Set(topic?.ticket_ids || []) : null;
  return tickets.filter(ticket => {
    if (topicIds && !topicIds.has(ticket.id)) return false;
    if (/^#?\d+$/.test(search)) return ticket.id === Number(search.replace(/^#/, ""));
    return search.split(/\s+/).every(word => normalize(ticket.question).includes(word));
  });
}
