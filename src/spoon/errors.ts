/** 公式ドキュメント「エラーコード」の detailCode のうち、処理を分ける必要があるもの */
export const DetailCode = {
  /** 401: トークン破棄から1分以内 */
  TokenJustRevoked: "OAPI_MNGR_0203",
  /** 403: DJ がボットの入場をブロックしている */
  EntryBlocked: "OAPI_MNGR_0209",
  /** 404: DJ が配信していない（エラーではなく状態） */
  NotLive: "OAPI_MNGR_0301",
  /** 403: チャットが凍結されているか、ボットのチャットが禁止されている */
  ChatUnavailable: "OAPI_MNGR_0208",
  /** 429: チャットの送信が多すぎる */
  ChatRateLimited: "OAPI_MNGR_0302",
} as const;

/** API（/v1/live など）のエラー。レスポンス形式は公式ドキュメント「エラーコード」に従う */
export class SpoonApiError extends Error {
  override readonly name = "SpoonApiError";

  constructor(
    readonly status: number,
    readonly detailCode: string | null,
    message: string,
    /** 1日あたりの上限超過（429 + Retry-After）で待つべき時間 */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  get isNotLive(): boolean {
    return this.status === 404 && this.detailCode === DetailCode.NotLive;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isDailyRateLimited(): boolean {
    return this.status === 429 && this.retryAfterMs !== null;
  }
}

/** トークンエンドポイント（/v1/oauth/*）のエラー。`{ error, error_description }` 形式 */
export class SpoonOAuthError extends Error {
  override readonly name = "SpoonOAuthError";

  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string | null,
  ) {
    super(description ? `${error}: ${description}` : error);
  }
}

/** Refresh Token が失効している。DJ が連携を解除したとみなす（仕様書 §4.5） */
export class TokenRevokedError extends Error {
  override readonly name = "TokenRevokedError";
}
