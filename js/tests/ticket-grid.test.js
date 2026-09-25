import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyRussianTranslations } from "../ticket-bank.js";
import { buildTicketSets, filterCatalog, questionStatus } from "../ticket-catalog-logic.js";

const read = name => JSON.parse(fs.readFileSync(new URL(`../../data/${name}`, import.meta.url)));
const bank = read("tickets-b-ru.json").tickets;
const translations = Object.assign({}, ...["1742-1758", "1759-1775", "1776-1792"].map(range => read(`eco-ru-${range}.json`)));
const tickets = applyRussianTranslations(bank, translations);

test("учебные билеты покрывают все 921 вопрос без пропусков и повторов", () => {
  const sets = buildTicketSets(tickets);
  assert.equal(sets.length, 31);
  assert.ok(sets.slice(0, 30).every(set => set.tickets.length === 30));
  assert.equal(sets[30].tickets.length, 21);
  const ids = sets.flatMap(set => set.tickets.map(ticket => ticket.id));
  assert.equal(new Set(ids).size, 921);
  assert.deepEqual(ids, tickets.map(ticket => ticket.id).sort((a, b) => a - b));
  assert.ok(ids.includes(337));
});

test("номера и состав билетов стабильны при перестановке исходного массива", () => {
  assert.deepEqual(buildTicketSets(tickets), buildTicketSets(tickets.slice().reverse()));
  assert.deepEqual(buildTicketSets([]), []);
});

test("поиск использует точный ID и пересекается с темой", () => {
  const topics = [{ id: 1, ticket_ids: [337] }];
  assert.deepEqual(filterCatalog(tickets, { query: "#337" }).map(t => t.id), [337]);
  assert.equal(filterCatalog(tickets, { query: "337", topicId: "2", topics }).length, 0);
  assert.equal(filterCatalog(tickets, { query: "337", topicId: "1", topics }).length, 1);
  assert.equal(filterCatalog(tickets, { query: "999999999" }).length, 0);
  assert.equal(filterCatalog([{ id: 1, question: "Зелёный автомобиль" }], { query: "зеленый АВТОМОБИЛЬ" }).length, 1);
});

test("ошибки имеют приоритет над решёнными в карточке вопроса", () => {
  const ticket = { id: 337 };
  assert.equal(questionStatus(ticket, { solved: [337], mistakes: [337] }), "Повторить");
  assert.equal(questionStatus(ticket, { solved: [337], mistakes: [] }), "Решён");
  assert.equal(questionStatus(ticket, { solved: [], mistakes: [] }), "Не решён");
});
