import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  acceptInboxUpdate,
  claimNextInbox,
  completeInbox,
  drainInbox,
} from "../src/inbox";
import { routeUpdate } from "../src/router";
import { getConversation } from "../src/conversation";
import { insertGroup } from "./group-fixtures";

const db = (env as any).DB as D1Database;

function update(updateId: number, chatId = 100) {
  return {
    update_id: updateId,
    message: { chat: { id: chatId, type: "private" }, from: { id: chatId }, text: "/start" },
  };
}

function workerEnv() {
  return {
    ...(env as any),
    BOT_TOKEN: "test",
    WEBHOOK_PATH_SECRET: "path",
    WEBHOOK_HEADER_SECRET: "header",
    ADMIN_CHAT_ID: "-1",
    ADMIN_IDS: "1",
  };
}

describe("durable inbox", () => {
  it("concurrent duplicate сохраняется один раз и не сбрасывает состояние", async () => {
    const results = await Promise.all([
      acceptInboxUpdate(db, update(1001)),
      acceptInboxUpdate(db, update(1001)),
    ]);
    expect(results.sort()).toEqual([false, true]);
    await db
      .prepare("UPDATE inbox SET state = 'failed', attempts = 4, retry_at = datetime('now', '+1 hour') WHERE update_id = 1001")
      .run();
    expect(await acceptInboxUpdate(db, update(1001))).toBe(false);
    const row = await db.prepare("SELECT state, attempts FROM inbox WHERE update_id = 1001").first<any>();
    expect(row).toEqual({ state: "failed", attempts: 4 });
  });

  it("позднее событие не обгоняет раннее с будущим retry_at", async () => {
    await acceptInboxUpdate(db, update(1010, 200));
    await acceptInboxUpdate(db, update(1011, 200));
    await db
      .prepare("UPDATE inbox SET state = 'failed', retry_at = datetime('now', '+1 hour') WHERE update_id = 1010")
      .run();

    expect(await claimNextInbox(db)).toBeNull();
    await db.prepare("UPDATE inbox SET retry_at = datetime('now') WHERE update_id = 1010").run();
    const first = await claimNextInbox(db);
    expect(first?.updateId).toBe(1010);
    await completeInbox(db, first!);
    const second = await claimNextInbox(db);
    expect(second?.updateId).toBe(1011);
    await completeInbox(db, second!);
  });

  it("просроченный worker не завершает update после смены fencing token", async () => {
    await acceptInboxUpdate(db, update(1020, 300));
    const stale = await claimNextInbox(db);
    expect(stale).not.toBeNull();
    await db
      .prepare(
        `UPDATE chat_leases
         SET lease_token = 'new-owner', revision = revision + 1,
             lease_until = datetime('now', '+1 minute')
         WHERE chat_id = 300`,
      )
      .run();

    expect(await completeInbox(db, stale!)).toBe(false);
    const row = await db.prepare("SELECT state, payload FROM inbox WHERE update_id = 1020").first<any>();
    expect(row.state).toBe("processing");
    expect(row.payload).not.toBeNull();
  });

  it("ошибка оставляет payload для повтора и фиксирует только безопасный код", async () => {
    await acceptInboxUpdate(db, update(1030, 400));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    await drainInbox(workerEnv() as any, async () => {
      throw new Error("телефон +995599000400 секретный текст ученика");
    }, 1);
    spy.mockRestore();

    const row = await db
      .prepare("SELECT state, attempts, last_error_code, payload, retry_at FROM inbox WHERE update_id = 1030")
      .first<any>();
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.last_error_code).toBe("Error");
    expect(JSON.stringify(row)).not.toContain("секретный текст ученика");
    expect(logs.join("\n")).not.toContain("+995599000400");
    expect(logs.join("\n")).not.toContain("секретный текст ученика");
    expect(row.payload).not.toBeNull();
    expect(row.retry_at).toBeTruthy();
  });

  it.each([
    { name: "без секрета", bookingSecret: undefined },
    { name: "с тестовым секретом", bookingSecret: "test-booking-secret".repeat(4) },
  ])("crash после доменного commit использует stable operation $name", async ({ bookingSecret }) => {
    await acceptInboxUpdate(db, update(1040, 500));
    let first = true;
    const operationIds: string[] = [];
    const handler = vi.fn(async (_update: any, scopedEnv: any, context: any) => {
      operationIds.push(context.operationId);
      await scopedEnv.DB
        .prepare("INSERT OR IGNORE INTO facts (key, value) VALUES (?, 'committed')")
        .bind(context.operationId)
        .run();
      if (first) {
        first = false;
        throw new Error("crash_after_commit");
      }
    });
    const e = workerEnv() as any;
    if (bookingSecret === undefined) {
      delete e.BOOKING_SECRET;
    } else {
      e.BOOKING_SECRET = bookingSecret;
    }

    expect(await drainInbox(e, handler, 1)).toBe(0);
    await db.prepare("UPDATE inbox SET retry_at = datetime('now') WHERE update_id = 1040").run();
    expect(await drainInbox(e, handler, 1)).toBe(1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    const count = await db
      .prepare("SELECT count(*) AS n FROM facts WHERE key = ?")
      .bind(operationIds[0])
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const marker = await db.prepare("SELECT state, payload, chat_id FROM inbox WHERE update_id = 1040").first<any>();
    expect(marker).toEqual({ state: "done", payload: null, chat_id: null });
  });

  it("crash после шага анкеты не разбирает тот же текст как следующий шаг", async () => {
    const chatId = 610;
    const groupId = await insertGroup(db, {
      id: "inbox-replay-group",
      sequence: 610,
      startDate: "2099-12-20",
    });
    const e = {
      ...workerEnv(),
      BOOKING_ENABLED: "true",
      BOOKING_SECRET: "x".repeat(64),
      ADMIN_ORIGIN: "https://admin.example.com",
      __fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))),
    } as any;
    const callback = (updateId: number, data: string) => ({
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: chatId },
        message: { chat: { id: chatId, type: "private" } },
        data,
      },
    });
    await acceptInboxUpdate(db, callback(61_001, "menu:zapis"));
    expect(await drainInbox(e, routeUpdate, 1)).toBe(1);
    await acceptInboxUpdate(db, callback(61_002, "bg:610:1"));
    expect(await drainInbox(e, routeUpdate, 1)).toBe(1);
    expect((await getConversation(db, chatId))?.data.groupId).toBe(groupId);

    const nameUpdate = {
      update_id: 61_003,
      message: { chat: { id: chatId, type: "private" }, from: { id: chatId }, text: "+995599000001" },
    };
    await acceptInboxUpdate(db, nameUpdate);
    let crash = true;
    const handler = vi.fn(async (received: any, scopedEnv: any, context: any) => {
      await routeUpdate(received, scopedEnv, context);
      if (crash) {
        crash = false;
        throw new Error("crash_after_conversation_commit");
      }
    });
    expect(await drainInbox(e, handler, 1)).toBe(0);
    const afterCommit = await getConversation(db, chatId);
    expect(afterCommit).toMatchObject({ step: "phone", data: { name: "+995599000001" } });

    await db.prepare("UPDATE inbox SET retry_at = datetime('now') WHERE update_id = 61003").run();
    expect(await drainInbox(e, handler, 1)).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getConversation(db, chatId)).toEqual(afterCommit);
  });
});
