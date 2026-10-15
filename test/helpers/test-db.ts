import { randomUUID } from "node:crypto";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { createPgDatabase, type Database, type Queryable } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";

/**
 * テスト用のメモリ上の PostgreSQL（PGlite）。本番の pg と同じ Database として扱う。
 * PGlite は1接続のため、トランザクションは直列に実行される。
 */
export function createPgliteDatabase(pglite: PGliteInterface = new PGlite()): Database {
  const wrap = (client: Pick<PGliteInterface, "query" | "exec">): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return result.rows;
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
  });

  return {
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}

/**
 * 本物の PostgreSQL 上に、テストごとの専用スキーマを作る。close で スキーマごと削除する。
 * pnpm test:pg（TEST_DATABASE_URL）で使う
 */
async function createPgSchemaDatabase(url: string): Promise<Database> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = createPgDatabase(url);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();

  const db = createPgDatabase(url, { searchPath: schema });
  return {
    ...db,
    async close() {
      await db.exec(`DROP SCHEMA ${schema} CASCADE`);
      await db.close();
    },
  };
}

/**
 * マイグレーション済みの PGlite をワーカーごとに1つ作っておき、テストごとに複製する。
 * PGlite の起動とマイグレーションは1秒以上かかるため、毎回行うと並列実行で時間切れになる
 */
let migratedTemplate: Promise<PGlite> | undefined;

function migratedPglite(): Promise<PGlite> {
  migratedTemplate ??= (async () => {
    const template = new PGlite();
    await migrate(createPgliteDatabase(template));
    return template;
  })();
  return migratedTemplate;
}

/** 空のテスト用データベース。TEST_DATABASE_URL があれば本物の PostgreSQL、なければ PGlite */
export async function createEmptyTestDatabase(): Promise<Database> {
  const url = process.env.TEST_DATABASE_URL;
  return url ? createPgSchemaDatabase(url) : createPgliteDatabase();
}

/** マイグレーション済みのテスト用データベース */
export async function createTestDatabase(): Promise<Database> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDatabase(await (await migratedPglite()).clone());
  const db = await createPgSchemaDatabase(url);
  await migrate(db);
  return db;
}
