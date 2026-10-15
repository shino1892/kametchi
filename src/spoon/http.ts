import { type Clock, systemClock } from "./clock.js";
import { SpoonApiError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** レスポンスヘッダーのレート制限情報（仕様書 §5.6）。上限値が非公開のため記録して調整に使う */
export interface RateLimitInfo {
  path: string;
  remaining: number | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
}

export interface SpoonHttpOptions {
  /** 例: https://jp-openapi.spooncast.net */
  baseUrl: string;
  fetch?: FetchLike;
  clock?: Clock;
  /** 秒単位の 429、500、502、通信エラーを再試行する回数 */
  maxRetries?: number;
  /** 指数バックオフの初回待機時間 */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onRateLimit?: (info: RateLimitInfo) => void;
}

export interface RequestOptions {
  query?: Record<string, string>;
  json?: unknown;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Bearer 認証で呼んでよい API（仕様書 §3）。申請で認可された権限の範囲だけで、
 * これ以外のパス・メソッドは送信する前に拒否する。OAuth（/v1/oauth/*）は oauth.ts が扱う
 */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
  "GET /v1/live",
  "GET /v1/live/events",
  "POST /v1/live/chat",
]);

/** 認可されていない API を呼ぼうとした（プログラムの誤り） */
export class EndpointNotAllowedError extends Error {
  override readonly name = "EndpointNotAllowedError";
}

/**
 * Spoon Developers API への HTTP 呼び出し。Bearer 認証、エラー形式の解釈、
 * 一時的な失敗の指数バックオフ再試行を行う。
 *
 * 1日あたりの上限超過（429 + Retry-After）は再試行せず、retryAfterMs 付きの
 * SpoonApiError として呼び出し側に返す。数時間待つ判断は呼び出し側で行う。
 */
export class SpoonHttp {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly clock: Clock;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onRateLimit: ((info: RateLimitInfo) => void) | undefined;

  constructor(options: SpoonHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? systemClock;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.onRateLimit = options.onRateLimit;
  }

  /** JSON を返す API を呼ぶ。204 なら undefined */
  async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    token: string,
    options: RequestOptions = {},
  ): Promise<T | undefined> {
    const response = await this.send(method, path, token, options, true);
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text === "" ? undefined : (JSON.parse(text) as T);
  }

  /** SSE を開く。ストリームの再接続は呼び出し側が行うため、ここでは再試行しない */
  async openStream(
    path: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.send("GET", path, token, signal ? { signal } : {}, false, {
      Accept: "text/event-stream",
    });
    if (!response.body) throw new SpoonApiError(response.status, null, "empty event stream");
    return response.body;
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    token: string,
    options: RequestOptions,
    retry: boolean,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    if (!ALLOWED_ENDPOINTS.has(`${method} ${path}`)) {
      throw new EndpointNotAllowedError(`${method} ${path} is not an allowed endpoint`);
    }
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);

    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...extraHeaders };
    const init: RequestInit = { method, headers };
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.json);
    }
    if (options.signal) init.signal = options.signal;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(url.toString(), init);
      } catch (error) {
        if (options.signal?.aborted || !retry || attempt >= this.maxRetries) throw error;
        await this.backoff(attempt, options.signal);
        continue;
      }

      this.reportRateLimit(path, response.headers);
      if (response.ok) return response;

      const error = await toApiError(response);
      const retryable = RETRYABLE_STATUS.has(response.status) && !error.isDailyRateLimited;
      if (!retry || !retryable || attempt >= this.maxRetries) throw error;
      await this.backoff(attempt, options.signal);
    }
  }

  private backoff(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    const ms = Math.min(this.baseBackoffMs * 2 ** attempt, this.maxBackoffMs);
    return this.clock.sleep(ms, signal);
  }

  private reportRateLimit(path: string, headers: Headers): void {
    if (!this.onRateLimit) return;
    const remaining = numberHeader(headers, "x-ratelimit-remaining");
    const dailyLimit = numberHeader(headers, "x-ratelimit-daily-limit");
    const dailyRemaining = numberHeader(headers, "x-ratelimit-daily-remaining");
    if (remaining === null && dailyLimit === null && dailyRemaining === null) return;
    this.onRateLimit({ path, remaining, dailyLimit, dailyRemaining });
  }
}

/** エラーレスポンスを SpoonApiError にする。本文が JSON でない場合も status だけで作る */
export async function toApiError(response: Response): Promise<SpoonApiError> {
  let detailCode: string | null = null;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record.detailCode === "string") detailCode = record.detailCode;
      if (typeof record.message === "string") message = record.message;
    }
  } catch {
    // 秒単位の 429 は本文がない
  }

  const retryAfterSec = numberHeader(response.headers, "retry-after");
  const retryAfterMs =
    response.status === 429 && retryAfterSec !== null ? retryAfterSec * 1000 : null;
  return new SpoonApiError(response.status, detailCode, message, retryAfterMs);
}

function numberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
