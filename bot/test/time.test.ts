import { describe, expect, it } from "vitest";
import { formatTbilisi } from "../src/time";

describe("formatTbilisi", () => {
  it("переводит UTC из формата SQLite в Тбилиси (+4)", () => {
    // 2026-08-31 20:30 UTC = 2026-09-01 00:30 в Тбилиси
    expect(formatTbilisi("2026-08-31 20:30:00")).toBe("01.09 00:30");
  });
});
