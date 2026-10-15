import type { Queryable } from "./database.js";

/** detail に入れてよい値。リスナーを特定する情報・チャット本文・トークンは入れない */
export type LogDetail = Record<string, string | number | boolean | null | string[]>;

/** 動作の記録（仕様書 §9.1: 30日で削除） */
export class AppLogRepository {
  constructor(private readonly db: Queryable) {}

  async record(type: string, detail: LogDetail = {}): Promise<void> {
    await this.db.query("INSERT INTO app_logs (type, detail) VALUES ($1, $2::jsonb)", [
      type,
      JSON.stringify(detail),
    ]);
  }

  async listRecent(
    limit = 100,
  ): Promise<Array<{ type: string; detail: LogDetail; createdAt: Date }>> {
    const rows = await this.db.query<{ type: string; detail: LogDetail; created_at: Date }>(
      "SELECT type, detail, created_at FROM app_logs ORDER BY id DESC LIMIT $1",
      [limit],
    );
    return rows.map((row) => ({
      type: row.type,
      detail: row.detail,
      createdAt: new Date(row.created_at),
    }));
  }
}
