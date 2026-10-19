import { defineConfig } from "vitest/config";

// pnpm test:pg（--mode pg）では、PGlite の代わりに本物の PostgreSQL でテストする
const PG_DEFAULT_URL = "postgres://kametchi:kametchi@localhost:5432/kametchi";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // PGlite（WebAssembly の PostgreSQL）はテストファイルごとに起動し、同時に多く起動すると
    // 互いに遅くなって時間切れになる。並列数を抑えたほうが全体も速い
    maxWorkers: 4,
    // データベースの準備を含むため、既定より余裕を持たせる
    testTimeout: 15_000,
    hookTimeout: 20_000,
    env:
      mode === "pg" ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? PG_DEFAULT_URL } : {},
  },
}));
