import type { LiveInfo, SpoonApi } from "../spoon/api.js";
import { type Clock, systemClock } from "../spoon/clock.js";
import { SpoonApiError } from "../spoon/errors.js";
import type { TokenManager } from "../spoon/token-manager.js";

export interface LiveWatcherHooks {
  /** 新しい配信を見つけた（同じ配信では1回だけ） */
  onLiveStarted(live: LiveInfo): void | Promise<void>;
  /** 見つけていた配信が終わった */
  onLiveEnded(live: LiveInfo): void | Promise<void>;
  /**
   * 連携の解除など、続けられないエラーか（TokenRevokedError など）。true を返したら確認をやめる。
   * 解除の処理はこの確認の完了を待つ（stop()）ため、ここでは待たずに始めるだけにする
   */
  onFatalError(error: unknown): boolean;
  onLog?(type: string, detail?: Record<string, string | number>): void;
}

export interface LiveWatcherOptions {
  /** 確認の間隔（仕様書 §6.1）。既定30秒 */
  intervalMs?: number;
  clock?: Clock;
}

/**
 * 推しの配信が始まった・終わったことを、GET /v1/live の定期確認で検知する（仕様書 §6.1）。
 * 確認だけではボットは入室しない（イベントストリームには接続しない）。
 */
export class LiveWatcher {
  private live: LiveInfo | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  /** 状態が変わったときだけ記録する */
  private lastError: string | null = null;
  private readonly intervalMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly api: Pick<SpoonApi, "getLive">,
    private readonly tokens: () => TokenManager | null,
    private readonly hooks: LiveWatcherHooks,
    options: LiveWatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.clock = options.clock ?? systemClock;
  }

  /** 見つけている配信。配信していなければ null */
  current(): LiveInfo | null {
    return this.live;
  }

  /** 定期確認を始める（すでに動いていれば何もしない） */
  start(): void {
    if (this.loop) return;
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.run(controller.signal).finally(() => {
      if (this.controller === controller) {
        this.controller = null;
        this.loop = null;
      }
    });
  }

  /** 定期確認を止め、見つけていた配信を忘れる（解除したとき） */
  async stop(): Promise<void> {
    this.controller?.abort(new Error("watcher stopped"));
    await this.loop;
    this.live = null;
    this.lastError = null;
  }

  /** 1回だけ確認する。見つけている配信を返す */
  async check(signal?: AbortSignal): Promise<LiveInfo | null> {
    const manager = this.tokens();
    if (!manager) return null;
    try {
      const live = await manager.withAccessToken((token) => this.api.getLive(token, signal));
      this.lastError = null;
      if (this.live && this.live.liveId !== live.liveId) await this.ended();
      if (!this.live) {
        this.live = live;
        this.hooks.onLog?.("live_detected", { liveId: live.liveId });
        await this.callHook(() => this.hooks.onLiveStarted(live));
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof SpoonApiError && error.isNotLive) {
        this.lastError = null;
        if (this.live) await this.ended();
      } else if (this.hooks.onFatalError(error)) {
        throw error;
      } else {
        const description = describe(error);
        if (description !== this.lastError)
          this.hooks.onLog?.("watch_failed", { error: description });
        this.lastError = description;
        if (error instanceof SpoonApiError && error.retryAfterMs !== null) {
          await this.clock.sleep(error.retryAfterMs, signal);
        }
      }
    }
    return this.live;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.check(signal);
        await this.clock.sleep(this.intervalMs, signal);
      } catch {
        // 中断、または続けられないエラー（呼び出し側で解除などを行う）
        return;
      }
    }
  }

  private async ended(): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = null;
    this.hooks.onLog?.("live_ended", { liveId: live.liveId });
    await this.callHook(() => this.hooks.onLiveEnded(live));
  }

  /** 通知などの失敗で、検知の状態を変えない */
  private async callHook(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.hooks.onLog?.("hook_failed", { error: describe(error) });
    }
  }
}

export function describe(error: unknown): string {
  if (error instanceof SpoonApiError) {
    return `${error.status}${error.detailCode ? ` ${error.detailCode}` : ""} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
