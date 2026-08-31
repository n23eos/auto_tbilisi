import { describe, expect, it } from "vitest";
import { escapeHtml, escapeClamped } from "../src/escape";

describe("escapeHtml", () => {
  it("экранирует & < >", () => {
    expect(escapeHtml('<b>Вася & "Ко"</b>')).toBe("&lt;b&gt;Вася &amp; \"Ко\"&lt;/b&gt;");
  });
  it("обычный текст не трогает", () => {
    expect(escapeHtml("Привет, мир")).toBe("Привет, мир");
  });
});

describe("escapeClamped", () => {
  it("короткий текст возвращает как обычное экранирование", () => {
    expect(escapeClamped("<b>", 100)).toBe("&lt;b&gt;");
  });

  it("считает лимит по ГОТОВОЙ строке, а не по исходной", () => {
    // 100 символов «<» — это 400 символов «&lt;».
    expect(escapeClamped("<".repeat(100), 50).length).toBeLessThanOrEqual(50);
  });

  it("не разрубает HTML-сущность пополам", () => {
    const out = escapeClamped("<".repeat(100), 50);
    // Всё, кроме финального многоточия, — целые «&lt;».
    expect(out.slice(0, -1)).toMatch(/^(&lt;)*$/);
    expect(out.endsWith("…")).toBe(true);
  });
});
