import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/escape";

describe("escapeHtml", () => {
  it("экранирует & < >", () => {
    expect(escapeHtml('<b>Вася & "Ко"</b>')).toBe("&lt;b&gt;Вася &amp; \"Ко\"&lt;/b&gt;");
  });
  it("обычный текст не трогает", () => {
    expect(escapeHtml("Привет, мир")).toBe("Привет, мир");
  });
});
