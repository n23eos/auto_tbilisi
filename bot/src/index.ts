import { routeUpdate } from "./router";
import { runCleanup } from "./cleanup";
import type { Env } from "./types";

/** true — обновление новое; false — уже видели (Telegram ретраит). */
async function isFreshUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)")
    .bind(updateId)
    .run();
  return res.meta.changes > 0;
}

/**
 * Опознавательные знаки апдейта для лога. Апдейт помечается обработанным ДО вызова
 * роутера, поэтому упавший апдейт больше не повторится — в `wrangler tail` должно быть
 * видно, какой это был апдейт и какому ученику не ответили, чтобы написать ему руками.
 */
function describeUpdate(update: any): string {
  const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? "?";
  const userId = update?.message?.from?.id ?? update?.callback_query?.from?.id ?? "?";
  return `update_id=${update?.update_id} chat_id=${chatId} user_id=${userId}`;
}

/** Имена секретов вебхука, которые не заданы или пусты. Пустой массив — всё на месте. */
function missingSecrets(env: Env): string[] {
  return (["WEBHOOK_PATH_SECRET", "WEBHOOK_HEADER_SECRET"] as const).filter((name) => !env[name]);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const notFound = new Response("Not found", { status: 404 });

    // Незаданный секрет — не «слабее», а опаснее: `${undefined}` превратил бы путь в
    // общеизвестный `/webhook/undefined`. Поэтому проверяем оба секрета ДО сравнений и
    // при пропаже отвечаем 404 на всё: снаружи воркер неотличим от неверного адреса,
    // а причину видно в `wrangler tail`.
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      console.error(
        `Вебхук отключён: не заданы секреты ${missing.join(", ")}. ` +
          `Задайте их через \`npx wrangler secret put <ИМЯ>\` — см. bot/README.md, шаг 4.`,
      );
      return notFound;
    }

    const url = new URL(request.url);
    // Секретный путь — первый рубеж: чужой запрос не должен даже узнать, что тут вебхук.
    if (request.method !== "POST" || url.pathname !== `/webhook/${env.WEBHOOK_PATH_SECRET}`) {
      return notFound;
    }
    // Второй рубеж на случай утечки URL (логи прокси, Logpush, Referer): секрет заголовка
    // независим от секрета пути, поэтому раскрытие адреса не раскрывает его. Отсутствующий
    // заголовок даёт null, а null не равен непустой строке — проверка закрыта по умолчанию.
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_HEADER_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: any;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    // Без update_id дедуплицировать нечем — такой запрос Telegram не присылает.
    if (typeof update?.update_id !== "number") return new Response("Bad request", { status: 400 });

    if (await isFreshUpdate(env.DB, update.update_id)) {
      try {
        await routeUpdate(update, env);
      } catch (err) {
        // Ошибку логируем, но отвечаем 200: update уже помечен обработанным,
        // ретрай Telegram всё равно был бы отброшен дедупликацией. Плюс ответ не-200
        // останавливает всю очередь апдейтов бота, а не только этот один.
        console.error(`routeUpdate упал (${describeUpdate(update)}):`, err);
      }
    }
    return Response.json({ ok: true });
  },

  // Падение чистки намеренно не глушим: cron некому показать ошибку, кроме дашборда
  // Cloudflare, а работа идемпотентна и полностью повторится завтра.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runCleanup(env.DB);
  },
} satisfies ExportedHandler<Env>;
