import { describe, expect, it, vi } from "vitest";
import { TelegramClient, splitMessage } from "../src/telegram";

function fakeFetch(result: unknown = { message_id: 42 }) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("TelegramClient", () => {
  it("шлёт sendMessage на правильный URL c HTML parse_mode", async () => {
    const f = fakeFetch();
    const tg = new TelegramClient("TOKEN", f);
    const res = await tg.sendMessage(123, "привет");
    expect(res.message_id).toBe(42);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ chat_id: 123, text: "привет", parse_mode: "HTML" });
  });

  it("бросает ошибку при ok:false", async () => {
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const tg = new TelegramClient("TOKEN", f);
    await expect(tg.sendMessage(1, "x")).rejects.toThrow("Bad Request");
  });
});

describe("splitMessage", () => {
  it("короткий текст — один кусок", () => {
    expect(splitMessage("abc")).toEqual(["abc"]);
  });
  it("режет длинный текст по абзацам, куски ≤ лимита", () => {
    const long = Array.from({ length: 100 }, (_, i) => `Абзац ${i} ${"х".repeat(80)}`).join("\n\n");
    const parts = splitMessage(long, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    expect(parts.join("\n\n")).toBe(long);
  });
});
