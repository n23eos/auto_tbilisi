import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Миграции читаются на старте и кладутся в биндинг: setupFiles применяет их
// к чистой базе перед каждым файлом тестов (см. test/apply-migrations.ts).
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
