import { type Clock, systemClock } from "./clock.js";
import { SpoonOAuthError } from "./errors.js";
import type { FetchLike } from "./http.js";

/** 要求する権限（仕様書 §3）。申請した4つだけで、これ以外は要求しない */
export const REQUIRED_SCOPES = ["live.read", "events.chat", "events.like", "chat.send"] as const;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Access Token の失効時刻（epoch ミリ秒） */
  expiresAt: number;
  scopes: string[];
}

export interface SpoonOAuthOptions {
  /** API ベースURL。例: https://jp-openapi.spooncast.net */
  baseUrl: string;
  /** 例: https://developers.spooncast.net/jp/oauth/authorize */
  authorizeUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike;
  clock?: Clock;
}

/** Spoon の OAuth 2.0（Authorization Code Grant）。仕様書 §4.1〜§4.3 */
export class SpoonOAuthClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly clock: Clock;

  constructor(private readonly options: SpoonOAuthOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? systemClock;
  }

  /** DJ を誘導する同意画面の URL。state はリクエストごとに新しく作ったランダム値を渡す */
  authorizeUrl(state: string, scopes: readonly string[] = REQUIRED_SCOPES): string {
    const url = new URL(this.options.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    // URLSearchParams は空白を + にするため、公式ドキュメントどおり %20 にそろえる
    return url.toString().replaceAll("+", "%20");
  }

  /** 同意後の code（60秒以内・1回限り）をトークンに交換する */
  exchangeCode(code: string): Promise<TokenSet> {
    return this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.options.redirectUri,
    });
  }

  /** トークンを更新する。古い Refresh Token は直ちに失効するため、返り値を必ず保存する */
  refresh(refreshToken: string): Promise<TokenSet> {
    return this.requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** トークンを無効化する。Refresh Token を渡すと同じ連携の Access Token も失効する */
  async revoke(token: string): Promise<void> {
    const response = await this.post("/v1/oauth/revoke", { token });
    if (!response.ok) throw await toOAuthError(response);
  }

  private async requestToken(params: Record<string, string>): Promise<TokenSet> {
    const requestedAt = this.clock.now();
    const response = await this.post("/v1/oauth/token", params);
    if (!response.ok) throw await toOAuthError(response);
    return parseTokenResponse(await response.json(), requestedAt);
  }

  private post(path: string, params: Record<string, string>): Promise<Response> {
    const credentials = Buffer.from(
      `${this.options.clientId}:${this.options.clientSecret}`,
    ).toString("base64");
    return this.fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
  }
}

function parseTokenResponse(body: unknown, requestedAt: number): TokenSet {
  if (typeof body !== "object" || body === null) throw invalidResponse();
  const { access_token, refresh_token, expires_in, scope, token_type } = body as Record<
    string,
    unknown
  >;
  if (
    typeof access_token !== "string" ||
    typeof refresh_token !== "string" ||
    typeof expires_in !== "number" ||
    typeof scope !== "string" ||
    token_type !== "Bearer"
  ) {
    throw invalidResponse();
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    // 送信前の時刻を基準にし、通信にかかった時間ぶん早めに失効したとみなす
    expiresAt: requestedAt + expires_in * 1000,
    scopes: scope.split(" ").filter((s) => s !== ""),
  };
}

function invalidResponse(): SpoonOAuthError {
  return new SpoonOAuthError(200, "invalid_response", "unexpected token response");
}

async function toOAuthError(response: Response): Promise<SpoonOAuthError> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error = typeof body.error === "string" ? body.error : `http_${response.status}`;
    const description = typeof body.error_description === "string" ? body.error_description : null;
    return new SpoonOAuthError(response.status, error, description);
  } catch {
    return new SpoonOAuthError(response.status, `http_${response.status}`, null);
  }
}
