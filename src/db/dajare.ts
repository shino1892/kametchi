import type { Queryable } from "./database.js";

export interface DajareTarget {
  /** 公式の暗号化識別子（ボット×DJの組み合わせごとに一意） */
  userId: string;
  /** Discord で入力した、一覧表示用の名前 */
  memo: string;
}

/** ダジャレ判定の対象（仕様書 §8.1）。本人の了承を得たリスナーだけを登録する */
export class DajareTargetRepository {
  constructor(private readonly db: Queryable) {}

  /** 登録する。登録済みならメモだけ更新する */
  async add(connectionId: string, target: DajareTarget): Promise<void> {
    await this.db.query(
      `INSERT INTO dajare_targets (connection_id, user_id, memo) VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, user_id) DO UPDATE SET memo = EXCLUDED.memo`,
      [connectionId, target.userId, target.memo],
    );
  }

  /** 登録を外す。外したら true */
  async remove(connectionId: string, userId: string): Promise<boolean> {
    const rows = await this.db.query(
      "DELETE FROM dajare_targets WHERE connection_id = $1 AND user_id = $2 RETURNING 1",
      [connectionId, userId],
    );
    return rows.length > 0;
  }

  async list(connectionId: string): Promise<DajareTarget[]> {
    const rows = await this.db.query<{ user_id: string; memo: string }>(
      "SELECT user_id, memo FROM dajare_targets WHERE connection_id = $1 ORDER BY created_at",
      [connectionId],
    );
    return rows.map((row) => ({ userId: row.user_id, memo: row.memo }));
  }
}

export type DajarePostStatus = "voting" | "approved";

export interface DajarePost {
  messageId: string;
  channelId: string;
  status: DajarePostStatus;
  createdAt: Date;
}

interface PostRow {
  message_id: string;
  channel_id: string;
  status: DajarePostStatus;
  created_at: Date;
}

/**
 * Discord に投稿したダジャレの記録（仕様書 §8.3）。連携解除時に Discord から削除するための
 * メッセージ ID と投票の状態だけを持ち、本文・ニックネーム・user.id は持たない
 */
export class DajarePostRepository {
  constructor(private readonly db: Queryable) {}

  async add(connectionId: string, channelId: string, messageId: string): Promise<void> {
    await this.db.query(
      "INSERT INTO dajare_posts (message_id, connection_id, channel_id) VALUES ($1, $2, $3)",
      [messageId, connectionId, channelId],
    );
  }

  async get(messageId: string): Promise<DajarePost | null> {
    const [row] = await this.db.query<PostRow>(
      "SELECT message_id, channel_id, status, created_at FROM dajare_posts WHERE message_id = $1",
      [messageId],
    );
    return row ? toPost(row) : null;
  }

  /** 投票中の投稿を公認にする。投票中でなければ false（二重に確定させない） */
  async approve(messageId: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE dajare_posts SET status = 'approved' WHERE message_id = $1 AND status = 'voting'
       RETURNING 1`,
      [messageId],
    );
    return rows.length > 0;
  }

  /** 記録を消す（却下したとき、Discord で削除されたとき）。消したら true */
  async delete(messageId: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM dajare_posts WHERE message_id = $1 RETURNING 1", [
      messageId,
    ]);
    return rows.length > 0;
  }

  /** 連携に紐づく投稿すべて（連携解除時の削除用） */
  async listAll(connectionId: string): Promise<DajarePost[]> {
    const rows = await this.db.query<PostRow>(
      `SELECT message_id, channel_id, status, created_at FROM dajare_posts
       WHERE connection_id = $1 ORDER BY created_at`,
      [connectionId],
    );
    return rows.map(toPost);
  }
}

function toPost(row: PostRow): DajarePost {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}
