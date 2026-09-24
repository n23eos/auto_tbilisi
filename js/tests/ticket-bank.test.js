import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRussianTranslations } from "../ticket-bank.js";

const root = new URL("../../data/", import.meta.url);
const bank = JSON.parse(readFileSync(new URL("tickets-b-ru.json", root)));
const translations = Object.assign({}, ...[
  "eco-ru-1742-1758.json",
  "eco-ru-1759-1775.json",
  "eco-ru-1776-1792.json",
].map((name) => JSON.parse(readFileSync(new URL(name, root)))));

test("весь раздел эко-вождения доступен на русском без изменения правильных ответов", () => {
  const tickets = applyRussianTranslations(bank.tickets, translations);
  assert.equal(Object.keys(translations).length, 51);
  assert.equal(tickets.filter((ticket) => ticket.lang === "ru" && !ticket.withdrawn).length, 898);
  for (const source of bank.tickets.filter((ticket) => ticket.lang === "ka")) {
    const translated = tickets.find((ticket) => ticket.id === source.id);
    assert.equal(translated.lang, "ru", `билет ${source.id}`);
    assert.equal(translated.answers.length, source.answers.length);
    assert.equal(translated.correct, source.correct);
    assert.equal(translated.image, source.image);
  }
});

test("неполный или повреждённый перевод не показывает часть билетов как полный банк", () => {
  const incomplete = { ...translations };
  delete incomplete[1742];
  assert.throws(() => applyRussianTranslations(bank.tickets, incomplete), /неполный перевод/);
  assert.throws(() => applyRussianTranslations(bank.tickets, {
    ...translations, 1742: { question: "тест", answers: ["один"] },
  }), /неверный перевод билета 1742/);
});
