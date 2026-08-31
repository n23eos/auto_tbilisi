import { describe, expect, it } from "vitest";
import { searchKb, menuAnswer, CONTACTS } from "../src/kb";

describe("kb", () => {
  it("кнопки меню отдают непустые тексты нужных разделов", () => {
    expect(menuAnswer("ceny")).toContain("₾");
    expect(menuAnswer("dokumenty").length).toBeGreaterThan(100);
    expect(menuAnswer("ekzameny").length).toBeGreaterThan(100);
  });

  it("CONTACTS содержит телефон школы", () => {
    expect(CONTACTS).toContain("+995 599 98 77 07");
  });

  it("поиск находит раздел по словам вопроса", () => {
    const hit = searchKb("сколько стоит теория в группе");
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("ceny");
  });

  it("возвращает null на вопрос не по теме", () => {
    expect(searchKb("квантовая запутанность фотонов")).toBeNull();
  });

  // Дополнительные проверки по реальным вопросам учеников (см. отчёт по Task 5).
  it("поиск: сколько стоит площадка → ceny", () => {
    const hit = searchKb("сколько стоит площадка");
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("ceny");
  });

  it("поиск: какие документы нужны для получения прав → dokumenty", () => {
    const hit = searchKb("какие документы нужны для получения прав");
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("dokumenty");
  });

  it("поиск: как проходит экзамен в сакребуло → ekzameny", () => {
    const hit = searchKb("как проходит экзамен в сакребуло");
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("ekzameny");
  });

  it("поиск: какая сегодня погода → null", () => {
    expect(searchKb("какая сегодня погода")).toBeNull();
  });

  it("раздел fakty не побеждает в поиске, несмотря на дублирование фактов из всех тем", () => {
    // fakty — шпаргалка, дублирующая цены/документы/экзамены/права в сжатом виде.
    // Наивный подсчёт совпадений слов сделал бы его победителем почти всегда.
    const hit = searchKb("сколько стоит теория и какие документы нужны на экзамен");
    expect(hit).not.toBeNull();
    expect(hit!.id).not.toBe("fakty");
  });
});
