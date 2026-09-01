import { routeUpdate } from "./router";
import { runCleanup } from "./cleanup";
import { alertAdmins } from "./alert";
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

const encoder = new TextEncoder();

/**
 * Сравнение секрета за постоянное время: время ответа не зависит от того, сколько первых
 * символов угадано, поэтому подобрать секрет по таймингам нельзя.
 *
 * `timingSafeEqual` бросает TypeError на буферах разной длины, поэтому длину приходится
 * проверять заранее — и этим мы выдаём длину секрета. Здесь это ничего не стоит: длина
 * задана README (`openssl rand -hex 32`, 64 символа) и так публична, а разная длина в любом
 * случае означает несовпадение. `null` (заголовка нет) отсекаем до сравнения.
 */
function secretsMatch(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = encoder.encode(expected);
  const b = encoder.encode(actual);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Имена обязательных настроек, которые не заданы или пусты. Пустой массив — всё на месте.
 *
 * ADMIN_CHAT_ID и ADMIN_IDS здесь не для безопасности, а против тихой потери
 * заявок: [vars] в wrangler.toml намеренно нет, всё задаётся через
 * `wrangler secret put`. Забыть их на свежем деплое легко, и тогда бот
 * принимает анкеты, отвечает ученику «Заявка отправлена», а карточка уходит в
 * чат NaN и не доходит никуда. Отказ на входе шумный, потеря заявок — нет.
 */
function missingSecrets(env: Env): string[] {
  return (["WEBHOOK_PATH_SECRET", "WEBHOOK_HEADER_SECRET", "ADMIN_CHAT_ID", "ADMIN_IDS"] as const)
    .filter((name) => !env[name]);
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
    if (
      request.method !== "POST" ||
      !secretsMatch(`/webhook/${env.WEBHOOK_PATH_SECRET}`, url.pathname)
    ) {
      return notFound;
    }
    // Второй рубеж на случай утечки URL (логи прокси, Logpush, Referer): секрет заголовка
    // независим от секрета пути, поэтому раскрытие адреса не раскрывает его. Отсутствующий
    // заголовок даёт null, а null не равен непустой строке — проверка закрыта по умолчанию.
    if (
      !secretsMatch(
        env.WEBHOOK_HEADER_SECRET,
        request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
      )
    ) {
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
        const where = describeUpdate(update);
        console.error(`routeUpdate упал (${where}):`, err);
        // `wrangler tail` работает, только пока его кто-то держит открытым.
        // Без этого сообщения ученик остался бы без ответа, а школа узнала бы
        // об этом от него самого — если он вообще напишет второй раз.
        await alertAdmins(env, `Не ответили ученику: ${where}`, err);
      }
    }
    return Response.json({ ok: true });
  },

  // Падение чистки намеренно не глушим: работа идемпотентна и повторится завтра,
  // а проглоченная ошибка исчезла бы и из дашборда Cloudflare. Оповещение шлём
  // до проброса — иначе про ночной сбой никто не узнал бы до следующего захода
  // в дашборд, а телефоны учеников тем временем хранились бы дольше обещанного.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await runCleanup(env.DB);
    } catch (err) {
      console.error("runCleanup упал:", err);
      await alertAdmins(env, "Ночная уборка базы не прошла", err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
