import { readSessionSummary } from "./training-session.js?v=1";
import { loadTicketBank } from "./ticket-bank.js?v=1";
import { readProgress } from "./training-logic.js?v=4";
import { buildTicketSets, filterCatalog, indexCatalogProgress, questionStatus } from "./ticket-catalog-logic.js?v=2";

const page = document.querySelector("[data-catalog]");
const grid = document.getElementById("catalog-grid");
const status = document.getElementById("catalog-status");
const query = document.getElementById("catalog-query");
const topic = document.getElementById("catalog-topic");
let tickets = [];
let sets = [];
let ordinals = new Map();
let topics = [];
let progressIndex;
let topicsFailed = false;

function text(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}

function readSavedProgress() {
  try { return readProgress(window.localStorage); }
  catch { return readProgress({ getItem: () => null }); }
}

function renderResume() {
  const panel = document.getElementById("catalog-resume");
  if (!panel) return;
  let summary;
  try { summary = readSessionSummary(window.localStorage); } catch { summary = null; }
  panel.hidden = !summary;
  if (summary) {
    const label = Number.isInteger(summary.context.set) ? `Билет ${summary.context.set}` : "Тренировка";
    document.getElementById("catalog-resume-label").textContent = `${label}: вопрос ${summary.position} из ${summary.total}. Ответы сохранены в этом браузере.`;
  }
}

function render() {
  renderResume();
  const fragment = document.createDocumentFragment();
  if (page.dataset.catalog === "sets") {
    for (const set of sets) {
      const solved = set.tickets.filter(ticket => progressIndex.solved.has(ticket.id)).length;
      const mistakes = set.tickets.filter(ticket => progressIndex.mistakes.has(ticket.id)).length;
      const link = document.createElement("a");
      link.href = `/bilety/trenirovka/?set=${set.number}`;
      link.className = "ticket-tile";
      link.append(text("span", `Билет ${set.number}`, "ticket-tile__title"));
      link.append(text("span", `Вопросов: ${set.tickets.length}`, "ticket-tile__count"));
      link.append(text("span", `Верно: ${solved} из ${set.tickets.length}`, "ticket-tile__progress"));
      if (mistakes) link.append(text("span", `Повторить: ${mistakes}`, "catalog-badge catalog-badge--mistake"));
      else if (solved === set.tickets.length) link.append(text("span", "Все решены ✓", "catalog-badge catalog-badge--solved"));
      else link.append(text("span", "Открыть →", "ticket-tile__action"));
      fragment.append(link);
    }
    status.textContent = `Учебных билетов: ${sets.length} · Вопросов: ${tickets.length}`;
  } else {
    const filtered = filterCatalog(tickets, { query: query.value, topicId: topic.value, topics });
    for (const ticket of filtered) {
      const label = questionStatus(ticket, progressIndex);
      const link = document.createElement("a");
      link.href = `/bilety/trenirovka/?ticket=${ticket.id}`;
      link.className = "question-tile";
      const header = text("span", "", "question-tile__head");
      header.append(text("strong", `№ ${ordinals.get(ticket.id)}`), text("span", `ID ${ticket.id}`));
      link.append(header, text("span", ticket.question, "question-tile__text"));
      const style = label === "Повторить" ? "mistake" : label === "Решён" ? "solved" : "new";
      link.append(text("span", label, `catalog-badge catalog-badge--${style}`));
      fragment.append(link);
    }
    status.textContent = filtered.length
      ? `Вопросов показано: ${filtered.length} из ${tickets.length}. Номер в сетке и ID источника могут различаться.`
      : "Вопросов не найдено. Измените запрос или сбросьте поиск и тему.";
    if (topicsFailed) status.textContent += " Темы не загрузились, поиск и все вопросы доступны.";
  }
  grid.replaceChildren(fragment);
}

document.getElementById("catalog-search")?.addEventListener("submit", event => {
  event.preventDefault();
  render();
});
topic?.addEventListener("change", render);
document.getElementById("catalog-clear")?.addEventListener("click", () => {
  query.value = "";
  topic.value = "";
  render();
  query.focus();
});

// При возвращении назад карточки должны показывать только что данный ответ.
window.addEventListener("pageshow", () => {
  if (tickets.length) { progressIndex = indexCatalogProgress(readSavedProgress()); render(); }
});

async function init() {
  try {
    const bank = await loadTicketBank(new URL("../data/tickets-b-ru.json?v=2", import.meta.url));
    sets = buildTicketSets(bank);
    tickets = sets.flatMap(set => set.tickets);
    ordinals = new Map(tickets.map((ticket, index) => [ticket.id, index + 1]));
    progressIndex = indexCatalogProgress(readSavedProgress());
    render();
  } catch {
    status.textContent = "Не удалось загрузить вопросы. Обновите страницу, чтобы попробовать ещё раз.";
    return;
  }
  if (!topic) return;
  try {
    const response = await fetch(new URL("../data/ticket-topics.json", import.meta.url));
    if (!response.ok) throw new Error("темы недоступны");
    const data = await response.json();
    if (!Array.isArray(data.topics) || data.topics.some(item => !Array.isArray(item.ticket_ids))) throw new Error("неверные темы");
    topics = data.topics;
    for (const item of topics) topic.append(new Option(item.name, String(item.id)));
  } catch {
    topicsFailed = true;
    topic.disabled = true;
    render();
  }
}

init();
