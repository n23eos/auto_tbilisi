import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// Два разных секрета: путь и заголовок больше не совпадают.
const PATH_SECRET = "put-sekret";
const HEADER_SECRET = "zagolovok-sekret";

function makeEnv(fetchFn?: typeof fetch) {
  return {
    ...(env as any),
    BOT_TOKEN: "T",
    WEBHOOK_PATH_SECRET: PATH_SECRET,
    WEBHOOK_HEADER_SECRET: HEADER_SECRET,
    ADMIN_CHAT_ID: "-1",
    ADMIN_IDS: "777",
    __fetch:
      fetchFn ??
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))),
  };
}

function webhookRequest(
  body: object,
  secret: string | null = HEADER_SECRET,
  path = `/webhook/${PATH_SECRET}`,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // secret === null — заголовка нет вовсе (проверяем, что null не пройдёт как совпадение).
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request(`https://bot.example${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const update = (id: number) => ({
  update_id: id,
  message: { chat: { id: 9, type: "private" }, from: { id: 9 }, text: "/start" },
});

describe("webhook", () => {
  it("public booking route работает до проверки Telegram secrets", async () => {
    const e = makeEnv() as any;
    e.BOOKING_ENABLED = "true";
    e.BOOKING_SECRET = "x".repeat(64);
    e.WEBHOOK_PATH_SECRET = undefined;
    e.WEBHOOK_HEADER_SECRET = undefined;
    e.ADMIN_CHAT_ID = undefined;
    e.ADMIN_IDS = undefined;
    const response = await worker.fetch(
      new Request("https://bot.example/api/v1/groups?service_id=theory_group"),
      e,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("верный путь и верный заголовок — 200, апдейт обработан", async () => {
    const e = makeEnv() as any;
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(11)), e, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(e.__fetch.mock.calls.length).toBeGreaterThan(0);
  });

  it("не тот путь — 404", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      webhookRequest(update(1), HEADER_SECRET, "/other"),
      makeEnv() as any,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("GET по правильному пути — 404", async () => {
    const ctx = createExecutionContext();
    const req = new Request(`https://bot.example/webhook/${PATH_SECRET}`, {
      method: "GET",
      headers: { "X-Telegram-Bot-Api-Secret-Token": HEADER_SECRET },
    });
    const res = await worker.fetch(req, makeEnv() as any, ctx);
    expect(res.status).toBe(404);
  });

  it("неверный секретный заголовок — 403", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(2), "wrong"), makeEnv() as any, ctx);
    expect(res.status).toBe(403);
  });

  it("заголовка нет вовсе — 403", async () => {
    const e = makeEnv() as any;
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(3), null), e, ctx);
    expect(res.status).toBe(403);
    expect(e.__fetch.mock.calls.length).toBe(0);
  });

  // Сравнение за постоянное время работает только на буферах одной длины, иначе бросает
  // TypeError. Другая длина — обычный отказ, а не 500: иначе любой мусор клал бы вебхук.
  it("заголовок другой длины — 403, а не падение", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(8), "x"), makeEnv() as any, ctx);
    expect(res.status).toBe(403);
  });

  it("путь другой длины — 404, а не падение", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      webhookRequest(update(9), HEADER_SECRET, "/webhook/x"),
      makeEnv() as any,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("секрет пути в заголовке — 403: секреты независимы", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest(update(4), PATH_SECRET), makeEnv() as any, ctx);
    expect(res.status).toBe(403);
  });

  it("секрет заголовка в пути — 404: секреты независимы", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      webhookRequest(update(5), HEADER_SECRET, `/webhook/${HEADER_SECRET}`),
      makeEnv() as any,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  for (const missing of ["WEBHOOK_PATH_SECRET", "WEBHOOK_HEADER_SECRET", "ADMIN_CHAT_ID", "ADMIN_IDS"] as const) {
    for (const [label, value] of [["не задан", undefined], ["пустой", ""]] as const) {
      it(`${missing} ${label} — 404 даже с верными путём и заголовком, в лог уходит имя секрета`, async () => {
        const e = makeEnv() as any;
        e[missing] = value;
        const errors: string[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
          errors.push(args.map(String).join(" "));
        });

        const ctx = createExecutionContext();
        const res = await worker.fetch(webhookRequest(update(6)), e, ctx);
        spy.mockRestore();

        expect(res.status).toBe(404);
        expect(e.__fetch.mock.calls.length).toBe(0);
        expect(errors.join("\n")).toContain(missing);
      });
    }
  }

  it("оба секрета не заданы — путь /webhook/undefined не открывает вебхук", async () => {
    const e = makeEnv() as any;
    e.WEBHOOK_PATH_SECRET = undefined;
    e.WEBHOOK_HEADER_SECRET = undefined;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = createExecutionContext();
    const req = new Request("https://bot.example/webhook/undefined", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update(7)),
    });
    const res = await worker.fetch(req, e, ctx);
    spy.mockRestore();

    expect(res.status).toBe(404);
    expect(e.__fetch.mock.calls.length).toBe(0);
  });

  it("битый JSON — 400, ничего не обрабатывается", async () => {
    const e = makeEnv() as any;
    const ctx = createExecutionContext();
    const req = new Request(`https://bot.example/webhook/${PATH_SECRET}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": HEADER_SECRET,
      },
      body: "{не json",
    });
    const res = await worker.fetch(req, e, ctx);
    expect(res.status).toBe(400);
    expect(e.__fetch.mock.calls.length).toBe(0);
  });

  it("ошибка durable insert возвращает 503, чтобы Telegram повторил update", async () => {
    const e = makeEnv() as any;
    e.DB = {
      prepare: () => ({
        bind: () => ({ run: async () => { throw new Error("D1 unavailable"); } }),
      }),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(webhookRequest(update(32_001)), e, createExecutionContext());
    spy.mockRestore();
    expect(response.status).toBe(503);
    expect(e.__fetch).not.toHaveBeenCalled();
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

  it("падение обработчика: 200 Telegram, update остается в durable retry без chat_id в логе", async () => {
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
    expect(line).not.toContain("chat_id=9");
    expect(line).toContain("Error");
    expect(line).not.toContain("Telegram недоступен");
    const inbox = await (e.DB as D1Database)
      .prepare("SELECT state, attempts, payload, retry_at FROM inbox WHERE update_id = 44")
      .first<any>();
    expect(inbox).toMatchObject({ state: "failed", attempts: 1 });
    expect(inbox.payload).toContain('"update_id":44');
    expect(inbox.retry_at).toBeTruthy();
  });

  it("минутный cron повторяет упавший update и завершает его без ручной команды", async () => {
    const calls: any[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body);
      if (calls.length === 1) throw new Error("Telegram недоступен");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as unknown as typeof fetch;

    const e = makeEnv(fetchFn) as any;
    e.ADMIN_CHAT_ID = "-100777";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.fetch(webhookRequest(update(45)), e, ctx);
    await waitOnExecutionContext(ctx);
    await e.DB.prepare("UPDATE inbox SET retry_at = datetime('now') WHERE update_id = 45").run();
    await worker.scheduled!({ cron: "* * * * *", scheduledTime: Date.now() } as any, e);
    spy.mockRestore();

    expect(calls).toHaveLength(2);
    const inbox = await (e.DB as D1Database)
      .prepare("SELECT state, payload, chat_id FROM inbox WHERE update_id = 45")
      .first<any>();
    expect(inbox).toEqual({ state: "done", payload: null, chat_id: null });
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
