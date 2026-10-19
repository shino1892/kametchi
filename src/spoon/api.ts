import { SpoonApiError } from "./errors.js";
import type { SpoonHttp } from "./http.js";
import { type SseItem, SseParser } from "./sse.js";

/** GET /v1/live のうち kametchi が使う値（仕様書 §6.1） */
export interface LiveInfo {
  liveId: number;
  title: string;
  /** epoch ミリ秒 */
  startedAt: number;
}

/**
 * Spoon Developers API のエンドポイント（仕様書 §3）。トークンは呼び出しごとに渡す。
 * ここにある3つ以外の API は使わない（SpoonHttp の ALLOWED_ENDPOINTS でも拒否される）
 */
export class SpoonApi {
  constructor(private readonly http: SpoonHttp) {}

  /** 配信情報。配信していなければ isNotLive の SpoonApiError を投げる */
  async getLive(token: string, signal?: AbortSignal): Promise<LiveInfo> {
    const body = await this.http.requestJson<Record<string, unknown>>(
      "GET",
      "/v1/live",
      token,
      signal ? { signal } : {},
    );
    const startedAt = typeof body?.startedAt === "string" ? Date.parse(body.startedAt) : Number.NaN;
    if (typeof body?.liveId !== "number" || Number.isNaN(startedAt)) {
      throw invalidResponse("/v1/live");
    }
    return {
      liveId: body.liveId,
      title: typeof body.title === "string" ? body.title : "",
      startedAt,
    };
  }

  /** ボット名でチャットを送る（chat.send）。ボット自身の発言はイベントストリームに戻らない */
  async sendChat(token: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.http.requestJson("POST", "/v1/live/chat", token, {
      json: { message },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * イベントストリームに接続する。接続に失敗したら SpoonApiError を投げ、
   * 成功したら受信した項目を順に返す。ストリームが閉じたら反復が終わる。
   */
  async connectEvents(token: string, signal?: AbortSignal): Promise<AsyncIterable<SseItem>> {
    const body = await this.http.openStream("/v1/live/events", token, signal);
    return readSse(body, signal);
  }
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<SseItem> {
  const parser = new SseParser();
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  // fetch の実装によっては中断しても本文の読み取りが止まらないため、明示的に取り消す
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) {
        if (signal?.aborted) throw signal.reason;
        return;
      }
      yield* parser.feed(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
}

function invalidResponse(path: string): SpoonApiError {
  return new SpoonApiError(200, null, `unexpected response from ${path}`);
}
