import type { Env } from "./types";

// Временная заглушка: реальный роутер (webhook, cron) добавится в следующей задаче.
// Нужна уже сейчас, потому что wrangler.toml ссылается на неё как на main,
// а без main-скрипта @cloudflare/vitest-pool-workers не может поднять воркер для тестов D1.
export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
