import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

const db = (env as any).DB as D1Database;

await applyD1Migrations(db, (env as any).TEST_MIGRATIONS);

// Cloudflare-плагин изолирует хранилище на файл тестов, а не на каждый тест
// (раньше это делала опция isolatedStorage, её больше нет). Без чистки тесты
// внутри файла видели бы записи друг друга и начали бы зависеть от порядка:
// проверка «в базе нет заявок» проходила бы только первой в файле.
//
// Порядок таблиц важен: lead_events ссылается на leads(id).
// sqlite_sequence обнуляем, чтобы номера заявок в каждом тесте начинались с 1
// и ожидаемые в проверках id не зависели от предыдущих тестов.
const TABLES_CHILD_FIRST = ["lead_events", "leads", "conversations", "facts", "processed_updates"];

beforeEach(async () => {
  await db.batch([
    ...TABLES_CHILD_FIRST.map((table) => db.prepare(`DELETE FROM ${table}`)),
    db.prepare("DELETE FROM sqlite_sequence"),
  ]);
});
