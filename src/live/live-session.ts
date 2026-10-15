import type { LiveInfo, SpoonApi } from "../spoon/api.js";
import { type Clock, systemClock } from "../spoon/clock.js";
import { DetailCode, SpoonApiError, TokenRevokedError } from "../spoon/errors.js";
import { type EndReason, type ListenerActivityEvent, parseLiveEvent } from "../spoon/events.js";
import type { TokenManager } from "../spoon/token-manager.js";
import { describe } from "./live-watcher.js";

/** 退室した理由 */
export type LeaveReason =
  /** /leave・「退室」ボタン */
  | "manual"
  /** 配信が終わった（end: LIVE_ENDED、または GET /v1/live が 404 か別の配信） */
  | "live_ended"
  /** 同じ DJ に別の接続ができた（仕様書 §6.3） */
  | "duplicate_connection"
  /** DJ がボットの入場をブロックしている（403 OAPI_MNGR_0209） */
  | "blocked"
  /** 権限が足りない（403） */
  | "forbidden"
  /** 連携が解除された */
  | "unlinked";

export type JoinResult =
  | { kind: "joined"; live: LiveInfo }
  | { kind: "already_joined"; live: LiveInfo | null }
  | { kind: "not_linked" }
  | { kind: "not_live" }
  /** 接続できずに退室した（ブロックなど） */
  | { kind: "failed"; reason: LeaveReason };

export interface LiveSessionHooks {
  /** 参加中に受け取ったイベント（ハートコメント・ダジャレ判定に使う）。受信を止めないよう完了を待たない */
  onEvent?(event: ListenerActivityEvent, live: LiveInfo): void | Promise<void>;
  /** 退室した（manual 以外の理由も含む） */
  onLeft?(reason: LeaveReason, live: LiveInfo | null): void | Promise<void>;
  /**
   * 連携の解除などで続けられないエラーを渡す（TokenRevokedError なら解除の処理を行う）。
   * 解除の処理は退室（leave() の完了）を待つため、完了は待たない
   */
  onFatalError?(error: unknown): void | Promise<void>;
  onLog?(type: string, detail?: Record<string, string | number>): void;
}

export interface LiveSessionOptions {
  /** ハートビートが途絶えたら切断とみなす時間。既定45秒（仕様書 §6.3） */
  heartbeatTimeoutMs?: number;
  /** 切断・エラー後の再接続待ちの初期値。既定1秒 */
  reconnectBackoffMs?: number;
  /** 再接続待ちの上限。既定5分 */
  maxBackoffMs?: number;
  clock?: Clock;
}

type ConnectionOutcome =
  | { type: "end"; reason: EndReason }
  | { type: "lost"; cause: string }
  /** reconnectNow() による切り直し */
  | { type: "restart" };

/** 重複排除のために覚えておくイベント ID の数 */
const SEEN_EVENT_IDS = 1_000;

/**
 * 手動で参加しているあいだの、イベントストリームへの接続（仕様書 §6.2、§6.3）。
 *
 * 公式 API では「接続している＝ボットが部屋にいる」ため、join() で接続し、leave() で切断する。
 * 切断・TOKEN_EXPIRED・RECONNECT のときは、leave() されるまで自動で接続し直す。
 * 配信の終了・重複接続・ブロック・権限不足・連携解除では退室する。
 */
export class LiveSession {
  private live: LiveInfo | null = null;
  private controller: AbortController | null = null;
  private connection: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly api: Pick<SpoonApi, "getLive" | "connectEvents">,
    private readonly tokens: () => TokenManager | null,
    private readonly hooks: LiveSessionHooks = {},
    options: LiveSessionOptions = {},
  ) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.clock = options.clock ?? systemClock;
  }

  /** 参加中（接続し直している途中も含む） */
  isJoined(): boolean {
    return this.loop !== null;
  }

  /** 参加している配信 */
  current(): LiveInfo | null {
    return this.live;
  }

  /**
   * 配信に参加する。最初の接続ができるか、退室するまで待って結果を返す。
   * 参加中なら何もしない（ボタンの連打で接続し直さない）
   */
  async join(): Promise<JoinResult> {
    if (this.loop) return { kind: "already_joined", live: this.live };
    const manager = this.tokens();
    if (!manager) return { kind: "not_linked" };

    const controller = new AbortController();
    this.controller = controller;
    let settle: (result: JoinResult) => void = () => {};
    const first = new Promise<JoinResult>((resolve) => {
      settle = resolve;
    });

    const loop = this.run(controller.signal, settle).finally(() => {
      if (this.controller === controller) {
        this.controller = null;
        this.loop = null;
        this.live = null;
        this.seen.length = 0;
        this.seenSet.clear();
      }
    });
    this.loop = loop;
    const result = await first;
    // 参加できなかったときは、片付けが終わってから返す（すぐに押し直したときに「参加中」と答えない）
    if (result.kind !== "joined") await loop;
    return result;
  }

  /** 退室する。参加していなければ false */
  async leave(reason: LeaveReason = "manual"): Promise<boolean> {
    const controller = this.controller;
    const loop = this.loop;
    if (!controller || !loop) return false;
    controller.abort(new LeaveSignal(reason));
    await loop;
    return true;
  }

  /** 接続だけを切り直す（連携し直して、新しいトークンを使うとき）。参加中のまま */
  reconnectNow(): void {
    this.connection?.abort(new RestartSignal());
  }

  private async run(signal: AbortSignal, settle: (result: JoinResult) => void): Promise<void> {
    let failures = 0;
    let connected = false;
    let lastProblem: string | null = null;

    const leaveWith = async (reason: LeaveReason) => {
      const live = this.live;
      this.hooks.onLog?.("left", { reason, ...(live ? { liveId: live.liveId } : {}) });
      if (!connected) {
        settle(reason === "live_ended" ? { kind: "not_live" } : { kind: "failed", reason });
        // 参加できなかったときの理由は join() の結果で伝えるため、onLeft は呼ばない
        return;
      }
      try {
        await this.hooks.onLeft?.(reason, live);
      } catch (error) {
        this.hooks.onLog?.("hook_failed", { error: describe(error) });
      }
    };

    while (!signal.aborted) {
      const manager = this.tokens();
      if (!manager) return leaveWith("unlinked");

      try {
        // 接続のたびに配信を確かめる。切断中に配信が終わり、次の配信が始まっていた場合に
        // そのまま次の配信に入らないようにする
        const live = await manager.withAccessToken((token) => this.api.getLive(token, signal));
        if (this.live && this.live.liveId !== live.liveId) return leaveWith("live_ended");
        this.live = live;

        const outcome = await this.runConnection(manager, live, signal, () => {
          failures = 0;
          lastProblem = null;
          if (!connected) {
            connected = true;
            settle({ kind: "joined", live });
            this.hooks.onLog?.("joined", { liveId: live.liveId });
          } else {
            this.hooks.onLog?.("reconnected", { liveId: live.liveId });
          }
        });

        if (outcome.type === "restart") continue;
        if (outcome.type === "lost") {
          if (outcome.cause !== lastProblem) {
            this.hooks.onLog?.("stream_lost", { liveId: live.liveId, cause: outcome.cause });
          }
          lastProblem = outcome.cause;
          await this.sleep(this.backoff(failures++), signal);
          continue;
        }

        switch (outcome.reason) {
          case "LIVE_ENDED":
            return leaveWith("live_ended");
          case "TOKEN_EXPIRED":
            await manager.refresh();
            break;
          case "RECONNECT":
            break;
          case "DUPLICATE_CONNECTION":
            return leaveWith("duplicate_connection");
        }
      } catch (error) {
        if (signal.aborted) break;

        if (
          error instanceof TokenRevokedError ||
          (error instanceof SpoonApiError && error.status === 401)
        ) {
          void Promise.resolve(this.hooks.onFatalError?.(error)).catch(() => {});
          return leaveWith("unlinked");
        }
        if (error instanceof SpoonApiError && error.status === 403) {
          return leaveWith(error.detailCode === DetailCode.EntryBlocked ? "blocked" : "forbidden");
        }
        if (error instanceof SpoonApiError && error.isNotLive) return leaveWith("live_ended");

        const description = describe(error);
        if (description !== lastProblem)
          this.hooks.onLog?.("connect_failed", { error: description });
        lastProblem = description;
        const wait =
          error instanceof SpoonApiError && error.isDailyRateLimited
            ? (error.retryAfterMs ?? this.maxBackoffMs)
            : this.backoff(failures++);
        await this.sleep(wait, signal);
      }
    }

    // leave() で止めた
    const reason = signal.reason instanceof LeaveSignal ? signal.reason.reason : "manual";
    await leaveWith(reason);
  }

  private async runConnection(
    manager: TokenManager,
    live: LiveInfo,
    signal: AbortSignal,
    onConnected: () => void,
  ): Promise<ConnectionOutcome> {
    const connection = new AbortController();
    this.connection = connection;
    const forwardAbort = () => connection.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });

    let heartbeatTimedOut = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        heartbeatTimedOut = true;
        connection.abort(new Error("heartbeat timeout"));
      }, this.heartbeatTimeoutMs);
    };

    try {
      const items = await manager.withAccessToken((token) =>
        this.api.connectEvents(token, connection.signal),
      );
      onConnected();
      resetHeartbeat();

      for await (const item of items) {
        resetHeartbeat();
        if (item.type !== "event") continue;
        if (item.id && this.isDuplicate(item.id)) continue;

        const parsed = parseLiveEvent(item.event, item.data);
        if (!parsed.ok) continue;
        if (parsed.event.kind === "end") return { type: "end", reason: parsed.event.reason };
        this.emit(parsed.event, live);
      }
      return { type: "lost", cause: "stream closed" };
    } catch (error) {
      if (signal.aborted) throw error;
      if (connection.signal.reason instanceof RestartSignal) return { type: "restart" };
      if (heartbeatTimedOut) return { type: "lost", cause: "heartbeat timeout" };
      if (error instanceof SpoonApiError || error instanceof TokenRevokedError) throw error;
      return { type: "lost", cause: describe(error) };
    } finally {
      clearTimeout(heartbeatTimer);
      signal.removeEventListener("abort", forwardAbort);
      connection.abort(new Error("connection closed"));
      if (this.connection === connection) this.connection = null;
    }
  }

  /** 受信を止めないよう、onEvent の完了は待たない */
  private emit(event: ListenerActivityEvent, live: LiveInfo): void {
    if (!this.hooks.onEvent) return;
    void Promise.resolve()
      .then(() => this.hooks.onEvent?.(event, live))
      .catch((error: unknown) =>
        this.hooks.onLog?.("event_handler_failed", { error: describe(error) }),
      );
  }

  /** 同じイベント ID を2回処理しない（直近 SEEN_EVENT_IDS 件） */
  private isDuplicate(id: string): boolean {
    if (this.seenSet.has(id)) return true;
    this.seenSet.add(id);
    this.seen.push(id);
    if (this.seen.length > SEEN_EVENT_IDS) {
      const oldest = this.seen.shift();
      if (oldest !== undefined) this.seenSet.delete(oldest);
    }
    return false;
  }

  private backoff(failures: number): number {
    return Math.min(this.reconnectBackoffMs * 2 ** failures, this.maxBackoffMs);
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await this.clock.sleep(ms, signal);
    } catch {
      // leave() による中断。ループ側で終了を判定する
    }
  }
}

class LeaveSignal extends Error {
  constructor(readonly reason: LeaveReason) {
    super(`left: ${reason}`);
  }
}

class RestartSignal extends Error {
  constructor() {
    super("restart connection");
  }
}
