import pg from "pg";

/** SQL を実行できるもの（接続全体、またはトランザクション） */
export interface Queryable {
  /** パラメータ付きの SQL を1文実行し、行を返す */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** パラメータなしの SQL を複数文まとめて実行する（マイグレーション用） */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** fn の中の処理をひとつのトランザクションで実行する。例外が出たらロールバックする */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PostgreSQL（pg）の接続プール */
export function createPgDatabase(
  connectionString: string,
  options: { searchPath?: string } = {},
): Database {
  const pool = new pg.Pool({
    connectionString,
    // テストでスキーマを分けるときに使う
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });

  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  });

  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
