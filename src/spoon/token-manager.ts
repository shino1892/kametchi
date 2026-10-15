import { type Clock, systemClock } from "./clock.js";
import { SpoonApiError, SpoonOAuthError, TokenRevokedError } from "./errors.js";
import type { SpoonOAuthClient, TokenSet } from "./oauth.js";

/** 更新後のトークンを保存する先（段階3で暗号化DBに保存する） */
export interface TokenPersistence {
  save(tokens: TokenSet): Promise<void>;
}

export interface TokenManagerOptions {
  clock?: Clock;
  /** 失効のどれだけ前に更新するか。既定は5分（仕様書 §4.3） */
  refreshMarginMs?: number;
  /** DJ が権限を減らしたときに呼ばれる（仕様書 §4.5） */
  onScopesReduced?: (removed: string[]) => void;
}

/**
 * Spoon連携1件分のトークンを管理する。
 *
 * - 失効の5分前を過ぎたら、次の利用時に更新する
 * - 同時に複数の更新が走らないよう、更新中の Promise を共有する
 * - 古い Refresh Token は更新と同時に失効するため、新しい値を保存してから返す
 * - Refresh Token が無効（invalid_grant）なら連携解除とみなし TokenRevokedError を投げる
 */
export class TokenManager {
  private tokens: TokenSet;
  private refreshing: Promise<TokenSet> | null = null;
  private readonly clock: Clock;
  private readonly refreshMarginMs: number;
  private readonly onScopesReduced: ((removed: string[]) => void) | undefined;

  constructor(
    private readonly oauth: Pick<SpoonOAuthClient, "refresh">,
    initial: TokenSet,
    private readonly persistence: TokenPersistence,
    options: TokenManagerOptions = {},
  ) {
    this.tokens = initial;
    this.clock = options.clock ?? systemClock;
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000;
    this.onScopesReduced = options.onScopesReduced;
  }

  get scopes(): readonly string[] {
    return this.tokens.scopes;
  }

  hasScope(scope: string): boolean {
    return this.tokens.scopes.includes(scope);
  }

  /** 有効な Access Token を返す。失効が近ければ先に更新する */
  async accessToken(): Promise<string> {
    if (this.clock.now() >= this.tokens.expiresAt - this.refreshMarginMs) {
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  /** トークンを更新する。更新中に呼ばれたら同じ更新の結果を待つ */
  refresh(): Promise<TokenSet> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Access Token を使って API を呼ぶ。401 なら一度だけ更新して再試行する。
   * 更新後も 401 なら連携が無効になったとみなす（仕様書 §4.5）。
   */
  async withAccessToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    try {
      return await call(token);
    } catch (error) {
      if (!(error instanceof SpoonApiError && error.isUnauthorized)) throw error;
    }

    // 別の呼び出しがすでに更新していれば、その結果を使う
    if (this.tokens.accessToken === token) await this.refresh();
    try {
      return await call(this.tokens.accessToken);
    } catch (error) {
      if (error instanceof SpoonApiError && error.isUnauthorized) {
        throw new TokenRevokedError("access token rejected after refresh", { cause: error });
      }
      throw error;
    }
  }

  private async doRefresh(): Promise<TokenSet> {
    let next: TokenSet;
    try {
      next = await this.oauth.refresh(this.tokens.refreshToken);
    } catch (error) {
      if (error instanceof SpoonOAuthError && error.error === "invalid_grant") {
        throw new TokenRevokedError("refresh token is no longer valid", { cause: error });
      }
      throw error;
    }

    const removed = this.tokens.scopes.filter((scope) => !next.scopes.includes(scope));
    // 古い Refresh Token はすでに失効しているため、保存に失敗してもメモリ上は新しい値を使う
    this.tokens = next;
    await this.persistence.save(next);
    if (removed.length > 0) this.onScopesReduced?.(removed);
    return next;
  }
}
