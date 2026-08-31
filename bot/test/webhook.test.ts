import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

function makeEnv(fetchFn?: typeof fetch) {
  return {
    ...(env as any),
    BOT_TOKEN: "T",
    WEBHOOK_SECRET: "sekret",
    ADMIN_CHAT_ID: "-1",
    ADMIN_IDS: "",
    __fetch:
      fetchFn ??
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))),
  };
}

function webhookRequest(body: object, secret = "sekret", path = "/webhook/sekret") {
  return new Request(`https://bot.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(body),
  });
}

const update = (id: number) => ({
  update_id: id,
  message: { chat: { id: 9, type: "private" }, from: { id: 9 }, text: "/start" },
});

describe("webhook", () => {
  it("не тот путь — 404", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(1), "sekret", "/other"), makeEnv() as any, ctx);
    expect(res.status).toBe(404);
  });

  it("GET по правильному пути — 404", async () => {
    const ctx = createExecutionContext();
    const req = new Request("https://bot.example/webhook/sekret", {
      method: "GET",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "sekret" },
    });
    const res = await worker.fetch(req, makeEnv() as any, ctx);
    expect(res.status).toBe(404);
  });

  it("нет секретного заголовка — 403", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(2), "wrong"), makeEnv() as any, ctx);
    expect(res.status).toBe(403);
  });

  it("битый JSON — 400, ничего не обрабатывается", async () => {
    const e = makeEnv() as any;
    const ctx = createExecutionContext();
    const req = new Request("https://bot.example/webhook/sekret", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "sekret" },
      body: "{не json",
    });
    const res = await worker.fetch(req, e, ctx);
    expect(res.status).toBe(400);
    expect(e.__fetch.mock.calls.length).toBe(0);
  });

  it("валидный update обрабатывается, повторный — игнорируется", async () => {
    const e = makeEnv() as any;
    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(webhookRequest(update(33)), e, ctx1);
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(200);
    const callsAfterFirst = e.__fetch.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(webhookRequest(update(33)), e, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);
    expect(e.__fetch.mock.calls.length).toBe(callsAfterFirst);
  });

  it("падение обработчика: 200 Telegram, но в лог уходит update_id и чат ученика", async () => {
    const boom = vi.fn(async () => {
      throw new Error("Telegram недоступен");
    }) as unknown as typeof fetch;
    const e = makeEnv(boom) as any;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(44)), e, ctx);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();

    expect(res.status).toBe(200);
    const line = errors.join("\n");
    expect(line).toContain("44"); // update_id — чтобы найти апдейт
    expect(line).toContain("9"); // chat_id ученика — чтобы понять, кому не ответили
    expect(line).toContain("Telegram недоступен");
  });

  it("cron запускает чистку", async () => {
    const e = makeEnv() as any;
    await (e.DB as D1Database)
      .prepare("INSERT INTO processed_updates (update_id, seen_at) VALUES (777, datetime('now', '-8 days'))")
      .run();

    await worker.scheduled!({ cron: "0 3 * * *", scheduledTime: Date.now() } as any, e);

    const left = await (e.DB as D1Database)
      .prepare("SELECT count(*) AS n FROM processed_updates WHERE update_id = 777")
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
