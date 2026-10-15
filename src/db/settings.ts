import type { Queryable } from "./database.js";

export interface Settings {
  /** ハートコメント（仕様書 §7.3、§7.4） */
  heartComment: boolean;
}

export const DEFAULT_SETTINGS: Settings = { heartComment: true };

/** 設定（Spoon連携ごと）。行がなければ既定値 */
export class SettingsRepository {
  constructor(private readonly db: Queryable) {}

  async get(connectionId: string): Promise<Settings> {
    const [row] = await this.db.query<{ heart_comment: boolean }>(
      "SELECT heart_comment FROM settings WHERE connection_id = $1",
      [connectionId],
    );
    return row ? { heartComment: row.heart_comment } : { ...DEFAULT_SETTINGS };
  }

  /** 指定した項目だけを変えて保存し、変更後の設定を返す */
  async update(connectionId: string, changes: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get(connectionId)), ...changes };
    const [row] = await this.db.query<{ heart_comment: boolean }>(
      `INSERT INTO settings (connection_id, heart_comment) VALUES ($1, $2)
       ON CONFLICT (connection_id) DO UPDATE SET
         heart_comment = EXCLUDED.heart_comment, updated_at = now()
       RETURNING heart_comment`,
      [connectionId, next.heartComment],
    );
    if (!row) throw new Error("failed to save settings");
    return { heartComment: row.heart_comment };
  }
}
