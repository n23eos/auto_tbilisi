import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getFact, setFact } from "../src/facts";

const db = (env as any).DB as D1Database;

describe("facts", () => {
  it("getFact неизвестного ключа — null", async () => {
    expect(await getFact(db, "nope")).toBeNull();
  });

  it("setFact возвращает старое и новое значение", async () => {
    const first = await setFact(db, "next_group_date", "1 сентября", "admin1");
    expect(first).toEqual({ oldValue: null, newValue: "1 сентября" });
    const second = await setFact(db, "next_group_date", "15 сентября", "admin2");
    expect(second).toEqual({ oldValue: "1 сентября", newValue: "15 сентября" });
    expect(await getFact(db, "next_group_date")).toBe("15 сентября");
  });
});
