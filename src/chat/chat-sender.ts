import { type Clock, systemClock } from "../spoon/clock.js";
import { DetailCode, SpoonApiError, TokenRevokedError } from "../spoon/errors.js";

/** 送れなかった理由 */
export type SendFailure =
  /** 配信に参加していない（仕様書 §7.1: 参加中だけ送る） */
  | "not_joined"
  /** 送信が多すぎる（429 を待って送り直しても 429） */
  | "rate_limited"
  /** チャットの凍結・ボットのチャット禁止（403 OAPI_MNGR_0208） */
  | "chat_unavailable"
  /** chat.send の権限がない（403） */
  | "forbidden"
  /** 配信していない（404） */
  | "not_live"
  /** 空・200文字超など（400） */
  | "invalid"
  /** 待っている送信が多すぎる */
  | "queue_full"
  /** 連携が解除された */
  | "unlinked"
  | "error";

export type SendResult = { ok: true } | { ok: false; reason: SendFailure };

export interface ChatSenderOptions {
  /** 送信の間隔。既定1.5秒（仕様書 §7.1） */
  minIntervalMs?: number;
  /** 待っている送信の上限。既定20件。超えたら古いものから捨てる */
  maxQueue?: number;
  /** 送信過多（429 OAPI_MNGR_0302）のときに待つ時間。既定5秒 */
  rateLimitedWaitMs?: number;
  clock?: Clock;
  onLog?: (type: string, detail?: Record<string, string | number>) => void;
}

interface Pending {
  message: string;
  resolve(result: SendResult): void;
}

/**
 * ボットのチャット送信を1件ずつ、間隔を空けて送る（仕様書 §7.1）。
 * ハートコメントと Discord からのコメントで共有し、送った結果を呼び出し元に返す。
 *
 * - 429（OAPI_MNGR_0302）は待ってから1回だけ送り直す
 * - 403（OAPI_MNGR_0208、凍結など）・404（配信していない）は、待っている分も含めて捨てる
 * - 参加していないときは送らない
 */
export class ChatSender {
  private readonly queue: Pending[] = [];
  private running: Promise<void> | null = null;
  private controller = new AbortController();
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private readonly rateLimitedWaitMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly deps: {
      /** 公式 API でチャットを送る（POST /v1/live/chat） */
      send(message: string, signal: AbortSignal): Promise<void>;
      /** 配信に参加しているか */
      canSend(): boolean;
      /** 連携の解除を検知したとき */
      onUnlinked?(error: unknown): void;
    },
    private readonly options: ChatSenderOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 1_500;
    this.maxQueue = options.maxQueue ?? 20;
    this.rateLimitedWaitMs = options.rateLimitedWaitMs ?? 5_000;
    this.clock = options.clock ?? systemClock;
  }

  /** 送信を予約し、送った結果を返す */
  send(message: string): Promise<SendResult> {
    if (!this.deps.canSend()) return Promise.resolve(fail("not_joined"));
    return new Promise((resolve) => {
      this.queue.push({ message, resolve });
      if (this.queue.length > this.maxQueue) {
        this.queue.shift()?.resolve(fail("queue_full"));
        this.log("chat_dropped", { reason: "queue_full", count: 1 });
      }
      this.running ??= this.drain().finally(() => {
        this.running = null;
      });
    });
  }

  /** 待っている送信を捨てる（退室したとき）。送信中のものも取り消す */
  async clear(reason: SendFailure = "not_joined"): Promise<void> {
    this.dropAll(reason);
    this.controller.abort(new Error("chat sender cleared"));
    await this.running;
    this.controller = new AbortController();
  }

  /** 送り終わるまで待つ（テスト用） */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    const signal = this.controller.signal;
    while (this.queue.length > 0 && !signal.aborted) {
      const pending = this.queue.shift() as Pending;
      if (!this.deps.canSend()) {
        pending.resolve(fail("not_joined"));
        continue;
      }
      pending.resolve(await this.sendOne(pending.message, signal));
      try {
        await this.clock.sleep(this.minIntervalMs, signal);
      } catch {
        return;
      }
    }
  }

  private async sendOne(message: string, signal: AbortSignal): Promise<SendResult> {
    try {
      try {
        await this.deps.send(message, signal);
      } catch (error) {
        if (!(error instanceof SpoonApiError && error.detailCode === DetailCode.ChatRateLimited)) {
          throw error;
        }
        await this.clock.sleep(this.rateLimitedWaitMs, signal);
        await this.deps.send(message, signal);
      }
      this.log("chat_sent");
      return { ok: true };
    } catch (error) {
      if (signal.aborted) return fail("not_joined");
      const reason = failureOf(error);
      if (reason === "chat_unavailable" || reason === "forbidden" || reason === "not_live") {
        // 送れない状態なので、待っている分も捨てる
        const count = this.queue.length + 1;
        this.dropAll(reason);
        this.log("chat_dropped", { reason, count });
      } else {
        this.log("chat_dropped", { reason, count: 1 });
      }
      if (reason === "unlinked") this.deps.onUnlinked?.(error);
      return fail(reason);
    }
  }

  private dropAll(reason: SendFailure): void {
    for (const pending of this.queue.splice(0)) pending.resolve(fail(reason));
  }

  private log(type: string, detail?: Record<string, string | number>): void {
    this.options.onLog?.(type, detail);
  }
}

function failureOf(error: unknown): SendFailure {
  if (error instanceof TokenRevokedError) return "unlinked";
  if (!(error instanceof SpoonApiError)) return "error";
  if (error.status === 429) return "rate_limited";
  if (error.status === 403 && error.detailCode === DetailCode.ChatUnavailable) {
    return "chat_unavailable";
  }
  if (error.status === 403) return "forbidden";
  if (error.isNotLive) return "not_live";
  if (error.status === 400) return "invalid";
  return "error";
}

function fail(reason: SendFailure): SendResult {
  return { ok: false, reason };
}
