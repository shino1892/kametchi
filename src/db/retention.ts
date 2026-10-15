import type { Queryable } from "./database.js";

/** 保存期間（仕様書 §9.1）。PostgreSQL の interval 表記 */
export const RETENTION = {
  /** 動作の記録: 30日 */
  appLogs: "30 days",
} as const;

export interface RetentionResult {
  appLogs: number;
  linkInvites: number;
  oauthStates: number;
}

/**
 * 保存期間を過ぎたデータを削除する。連携・設定・判定対象・投稿の記録は連携解除まで残し、
 * 解除時に ConnectionRepository.delete でまとめて削除する。
 */
export async function runRetention(
  db: Queryable,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const appLogs = await db.query(
    "DELETE FROM app_logs WHERE created_at < $1::timestamptz - $2::interval RETURNING 1",
    [now, RETENTION.appLogs],
  );
  // 失効した state を先に数える（招待の削除で連鎖して消える分と区別するため）
  const oauthStates = await db.query(
    "DELETE FROM oauth_states WHERE expires_at <= $1 RETURNING 1",
    [now],
  );
  // 失効した招待（使用済みのものも、期限を過ぎたら消す）
  const linkInvites = await db.query(
    "DELETE FROM link_invites WHERE expires_at <= $1 RETURNING 1",
    [now],
  );
  return {
    appLogs: appLogs.length,
    linkInvites: linkInvites.length,
    oauthStates: oauthStates.length,
  };
}

export interface RetentionScheduleOptions {
  /** 実行間隔。既定は24時間（日次） */
  intervalMs?: number;
  onResult?: (result: RetentionResult) => void;
  onError?: (error: unknown) => void;
}

/** 起動時に1回、その後は一定間隔で削除を実行する。stop() で止める */
export function scheduleRetention(db: Queryable, options: RetentionScheduleOptions = {}) {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60_000;
  let running: Promise<void> | null = null;

  const runOnce = () => {
    // 前回の実行が終わっていなければ重ねて実行しない
    running ??= runRetention(db)
      .then((result) => options.onResult?.(result))
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(runOnce, intervalMs);
  timer.unref();
  const first = runOnce();

  return {
    /** 最初の実行の完了 */
    ready: first,
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
