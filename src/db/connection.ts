import { randomUUID } from "node:crypto";
import type { TokenSet } from "../spoon/oauth.js";
import type { TokenPersistence } from "../spoon/token-manager.js";
import type { Queryable } from "./database.js";
import type { TokenCipher } from "./token-cipher.js";

export interface SpoonConnection {
  id: string;
  scopes: string[];
  createdAt: Date;
}

interface ConnectionRow {
  id: string;
  scopes: string[];
  created_at: Date;
}

const COLUMNS = "id, scopes, created_at";

/**
 * Spoon連携（仕様書 §5）。連携は1件だけで、トークンは連携の ID に結びつけて暗号化し、
 * 平文では保存しない。
 */
export class ConnectionRepository {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: TokenCipher,
  ) {}

  /**
   * 連携を保存する。すでにあればトークンと権限を入れ替える（再連携）。
   * ID は変えないため、設定・判定対象・投稿の記録は引き継がれる
   */
  async save(tokens: TokenSet): Promise<SpoonConnection> {
    const existing = await this.get();
    const id = existing?.id ?? randomUUID();
    const [row] = await this.db.query<ConnectionRow>(
      `INSERT INTO spoon_connection (id, access_token_enc, refresh_token_enc, access_expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (singleton) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         access_expires_at = EXCLUDED.access_expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [id, ...this.encryptTokens(id, tokens)],
    );
    if (!row) throw new Error("failed to save spoon connection");
    return toConnection(row);
  }

  /** 現在の連携。連携していなければ null */
  async get(): Promise<SpoonConnection | null> {
    const [row] = await this.db.query<ConnectionRow>(`SELECT ${COLUMNS} FROM spoon_connection`);
    return row ? toConnection(row) : null;
  }

  async loadTokens(id: string): Promise<TokenSet> {
    const [row] = await this.db.query<{
      access_token_enc: string;
      refresh_token_enc: string;
      access_expires_at: Date;
      scopes: string[];
    }>(
      `SELECT access_token_enc, refresh_token_enc, access_expires_at, scopes
       FROM spoon_connection WHERE id = $1`,
      [id],
    );
    if (!row) throw new Error("spoon connection not found");
    return {
      accessToken: this.cipher.decrypt(row.access_token_enc, id),
      refreshToken: this.cipher.decrypt(row.refresh_token_enc, id),
      expiresAt: new Date(row.access_expires_at).getTime(),
      scopes: row.scopes,
    };
  }

  /** TokenManager が更新後のトークンを保存する先 */
  persistence(id: string): TokenPersistence {
    return {
      save: async (tokens) => {
        const rows = await this.db.query(
          `UPDATE spoon_connection SET
             access_token_enc = $2, refresh_token_enc = $3, access_expires_at = $4, scopes = $5,
             updated_at = now()
           WHERE id = $1 RETURNING id`,
          [id, ...this.encryptTokens(id, tokens)],
        );
        if (rows.length === 0) throw new Error("spoon connection not found");
      },
    };
  }

  /** 連携と、配下の設定・判定対象・投稿の記録をすべて削除する（仕様書 §5.4） */
  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM spoon_connection WHERE id = $1", [id]);
  }

  private encryptTokens(id: string, tokens: TokenSet): [string, string, Date, string[]] {
    return [
      this.cipher.encrypt(tokens.accessToken, id),
      this.cipher.encrypt(tokens.refreshToken, id),
      new Date(tokens.expiresAt),
      tokens.scopes,
    ];
  }
}

function toConnection(row: ConnectionRow): SpoonConnection {
  return { id: row.id, scopes: row.scopes, createdAt: new Date(row.created_at) };
}
