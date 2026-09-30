import { routeUpdate } from "./router";
import { runCleanup } from "./cleanup";
import { alertAdmins } from "./alert";
import { routeBookingRequest } from "./booking-api";
import { acceptInboxUpdate, drainInbox } from "./inbox";
import { dispatchOutbox } from "./outbox";
import type { Env } from "./types";

const encoder = new TextEncoder();

function errorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

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

async function drainAcceptedWork(env: Env): Promise<void> {
  await drainInbox(env, routeUpdate);
  if (env.BOOKING_ENABLED === "true") await dispatchOutbox(env);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const notFound = new Response("Not found", { status: 404 });

    // Публичные и административные маршруты имеют отдельную закрытую по
    // умолчанию конфигурацию и не зависят от временной недоступности Telegram.
    const bookingResponse = await routeBookingRequest(request, env);
    if (bookingResponse) return bookingResponse;

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

    try {
      await acceptInboxUpdate(env.DB, update);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return new Response("Bad request", { status: 400 });
      }
      console.error(`Inbox update_id=${update.update_id} не сохранен (${errorClass(error)})`);
      return new Response("Unavailable", { status: 503 });
    }
    // Telegram получает 200 после durable insert. Работа продолжается отдельно,
    // а минутный cron подберет событие, если текущий isolate завершится раньше.
    ctx.waitUntil(drainAcceptedWork(env));
    return Response.json({ ok: true });
  },

  // Падение чистки намеренно не глушим: работа идемпотентна и повторится завтра,
  // а проглоченная ошибка исчезла бы и из дашборда Cloudflare. Оповещение шлём
  // до проброса — иначе про ночной сбой никто не узнал бы до следующего захода
  // в дашборд, а телефоны учеников тем временем хранились бы дольше обещанного.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const failed: string[] = [];
    try {
      await drainInbox(env, routeUpdate);
    } catch (error) {
      failed.push("inbox");
      console.error(`drainInbox упал (${errorClass(error)})`);
    }
    if (env.BOOKING_ENABLED === "true") {
      try {
        await dispatchOutbox(env);
      } catch (error) {
        failed.push("outbox");
        console.error(`dispatchOutbox упал (${errorClass(error)})`);
      }
    }
    if (controller.cron !== "0 3 * * *") {
      if (failed.length > 0) throw new Error(`scheduled_failed:${failed.join(",")}`);
      return;
    }
    try {
      await runCleanup(env.DB);
    } catch (err) {
      failed.push("cleanup");
      console.error(`runCleanup упал (${errorClass(err)})`);
      await alertAdmins(env, "Ночная уборка базы не прошла", new Error(errorClass(err)));
    }
    if (failed.length > 0) throw new Error(`scheduled_failed:${failed.join(",")}`);
  },
} satisfies ExportedHandler<Env>;
