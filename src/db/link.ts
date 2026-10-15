import type { Queryable } from "./database.js";

/**
 * 連携用の招待と OAuth の state（仕様書 §5.1）。
 * 招待トークン・state・Cookie の値は、呼び出し側で SHA-256 にしたハッシュだけを受け取る。
 */
export class LinkRepository {
  constructor(private readonly db: Queryable) {}

  async createInvite(tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query("INSERT INTO link_invites (token_hash, expires_at) VALUES ($1, $2)", [
      tokenHash,
      expiresAt,
    ]);
  }

  /** まだ使われておらず、期限内の招待か（案内のページの表示用。招待は使わない） */
  async isInviteUsable(tokenHash: string, now: Date): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM link_invites
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    );
    return rows.length > 0;
  }

  /**
   * 招待を使用済みにし、state を招待とブラウザに結びつけて保存する。
   * 使えない招待（使用済み・期限切れ・存在しない）なら false。1文で行うため、
   * 同じ招待が同時に使われても state は1つしかできない
   */
  async useInvite(
    tokenHash: string,
    state: { stateHash: string; browserHash: string; expiresAt: Date },
    now: Date,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `WITH used AS (
         UPDATE link_invites SET used_at = $2
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
         RETURNING token_hash
       )
       INSERT INTO oauth_states (state_hash, invite_hash, browser_hash, expires_at)
       SELECT $3, token_hash, $4, $5 FROM used
       RETURNING 1`,
      [tokenHash, now, state.stateHash, state.browserHash, state.expiresAt],
    );
    return rows.length > 0;
  }

  /**
   * コールバックで state を確かめて消す（1回限り）。同じブラウザから、期限内に戻ってきた場合だけ true。
   * 一致しなくても state は消す（同じ state で何度も試せないようにする）
   */
  async consumeState(stateHash: string, browserHash: string, now: Date): Promise<boolean> {
    const [row] = await this.db.query<{ browser_hash: string; expires_at: Date }>(
      "DELETE FROM oauth_states WHERE state_hash = $1 RETURNING browser_hash, expires_at",
      [stateHash],
    );
    if (!row) return false;
    return row.browser_hash === browserHash && new Date(row.expires_at) > now;
  }
}
