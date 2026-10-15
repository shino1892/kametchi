import { readdir, readFile } from "node:fs/promises";
import type { Database } from "./database.js";

/** src/db・dist/db のどちらから実行しても、リポジトリ直下の migrations/ を指す */
export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

/** 複数のプロセスが同時に適用しないためのロックキー */
const MIGRATION_LOCK_KEY = 74_210_015;

/**
 * migrations/ の SQL ファイルを名前順に、未適用のものだけ適用する。
 * 1ファイルを1トランザクションで適用し、適用済みの記録を schema_migrations に残す。
 */
export async function migrate(db: Database, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const sql = await readFile(new URL(file, dir), "utf8");
    const done = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const existing = await tx.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        version,
      ]);
      if (existing.length > 0) return false;
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      return true;
    });
    if (done) applied.push(version);
  }
  return applied;
}
