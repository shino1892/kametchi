import { createHash, randomBytes } from "node:crypto";
import type { AppLogRepository } from "../db/app-logs.js";
import type { ConnectionRepository, SpoonConnection } from "../db/connection.js";
import type { DajarePostRepository, DajareTargetRepository } from "../db/dajare.js";
import type { LinkRepository } from "../db/link.js";
import { type Clock, systemClock } from "../spoon/clock.js";
import { TokenRevokedError } from "../spoon/errors.js";
import { REQUIRED_SCOPES, type SpoonOAuthClient } from "../spoon/oauth.js";
import { TokenManager } from "../spoon/token-manager.js";

/** 招待・state の有効期間（仕様書 §5.1） */
export const LINK_TTL_MS = 10 * 60_000;

/** 配信がない期間も Refresh Token（30日）が失効しないように更新する間隔（仕様書 §3.1） */
const KEEP_ALIVE_MS = 24 * 60 * 60_000;

/** 招待トークン・state・ブラウザの値（32バイトの base64url） */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 権限がないと使えない機能（Discord での案内用） */
export const SCOPE_FEATURES: Record<string, string> = {
  "live.read": "配信の検知",
  "events.chat": "チャットの受信（ダジャレ判定・ハートコメントのコマンド）",
  "events.like": "ハートの受信（ハートコメント）",
  "chat.send": "チャットの送信（ハートコメント・Discord からのコメント）",
};

export type CompleteResult =
  | { kind: "linked"; relinked: boolean; missingScopes: string[] }
  /** state が一致しない・期限切れ・使用済み */
  | { kind: "invalid" }
  /** DJ が同意しなかった */
  | { kind: "denied" }
  /** live.read がないため連携を受け付けなかった */
  | { kind: "insufficient"; missingScopes: string[] }
  /** トークンの交換に失敗した */
  | { kind: "failed" };

export type UnlinkReason = "manual" | "revoked";

export interface UnlinkResult {
  reason: UnlinkReason;
  deletedPosts: number;
  /** Discord から削除できなかった投稿の数 */
  failedPosts: number;
}

export interface SpoonLinkHooks {
  /** Discord のメインチャンネルへの通知 */
  notify(message: string): Promise<void>;
  /** Discord のダジャレ投稿を削除する。すでにない投稿は成功とみなす */
  deleteDiscordMessage(channelId: string, messageId: string): Promise<void>;
}

export interface SpoonLinkDeps {
  connections: ConnectionRepository;
  link: LinkRepository;
  dajareTargets: DajareTargetRepository;
  dajarePosts: DajarePostRepository;
  logs: AppLogRepository;
  oauth: Pick<SpoonOAuthClient, "authorizeUrl" | "exchangeCode" | "refresh" | "revoke">;
  /** 連携用ページの URL（例: https://kametchi.com） */
  baseUrl: string;
  hooks: SpoonLinkHooks;
  clock?: Clock;
  onError?: (error: unknown, context: string) => void;
}

/** 連携・解除に合わせて動かすもの（段階3以降の配信への参加など） */
export interface LinkListener {
  /** 連携した・連携し直した（新しいトークンで動かし直す） */
  onLinked?(): void | Promise<void>;
  /** 解除の前に呼ばれる（配信から退室するなど） */
  onUnlinking?(): void | Promise<void>;
}

/**
 * Spoon連携（仕様書 §5）。Discord の /link で招待を作り、推しが開いたページから
 * Spoon の同意画面に送り、コールバックでトークンを保存する。/unlink や連携解除の検知で、
 * トークンを無効化してデータを削除する。連携中は TokenManager を1つ持つ。
 */
export class SpoonLink {
  private connection: SpoonConnection | null = null;
  private manager: TokenManager | null = null;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private unlinking: Promise<UnlinkResult | null> | null = null;
  private readonly listeners: LinkListener[] = [];
  private readonly clock: Clock;

  constructor(private readonly deps: SpoonLinkDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** 起動時に保存済みの連携を読み込む */
  async load(): Promise<void> {
    const connection = await this.deps.connections.get();
    await this.activate(connection);
  }

  /** 連携を止める（プロセスの終了時）。データは消さない */
  stop(): void {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }

  addListener(listener: LinkListener): void {
    this.listeners.push(listener);
  }

  isLinked(): boolean {
    return this.manager !== null;
  }

  /** 連携の ID（設定などの読み書きに使う）。連携していなければ null */
  connectionId(): string | null {
    return this.connection?.id ?? null;
  }

  /** 連携中のトークン。連携していなければ null */
  tokens(): TokenManager | null {
    return this.manager;
  }

  // ---- 連携 ----

  /** 10分間・1回限りの招待を作り、推しに開いてもらう URL を返す */
  async createInvite(): Promise<{ url: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(this.clock.now() + LINK_TTL_MS);
    await this.deps.link.createInvite(hash(token), expiresAt);
    await this.log("invite_created");
    return { url: `${this.deps.baseUrl}/link/${token}`, expiresAt };
  }

  /** 案内のページを出してよい招待か。招待は使わない（リンクプレビューで消費されないように） */
  async isInviteUsable(token: string): Promise<boolean> {
    if (!TOKEN_PATTERN.test(token)) return false;
    return this.deps.link.isInviteUsable(hash(token), new Date(this.clock.now()));
  }

  /**
   * 招待を使用済みにし、Spoon の同意画面の URL と、ブラウザの Cookie に入れる値を返す。
   * 使えない招待なら null
   */
  async startAuthorization(
    token: string,
  ): Promise<{ authorizeUrl: string; browserSecret: string } | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const state = randomToken();
    const browserSecret = randomToken();
    const now = this.clock.now();
    const used = await this.deps.link.useInvite(
      hash(token),
      {
        stateHash: hash(state),
        browserHash: hash(browserSecret),
        expiresAt: new Date(now + LINK_TTL_MS),
      },
      new Date(now),
    );
    if (!used) return null;
    return { authorizeUrl: this.deps.oauth.authorizeUrl(state), browserSecret };
  }

  /** コールバック。state と Cookie を照合し、code をトークンに交換して保存する */
  async completeAuthorization(params: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    browserSecret?: string | undefined;
  }): Promise<CompleteResult> {
    const { code, state, error, browserSecret } = params;
    if (
      !state ||
      !browserSecret ||
      !TOKEN_PATTERN.test(state) ||
      !TOKEN_PATTERN.test(browserSecret)
    ) {
      return { kind: "invalid" };
    }
    const valid = await this.deps.link.consumeState(
      hash(state),
      hash(browserSecret),
      new Date(this.clock.now()),
    );
    if (!valid) return this.fail({ kind: "invalid" });
    if (error) return this.fail({ kind: "denied" });
    if (!code) return this.fail({ kind: "invalid" });

    let tokens: Awaited<ReturnType<SpoonOAuthClient["exchangeCode"]>>;
    try {
      tokens = await this.deps.oauth.exchangeCode(code);
    } catch (exchangeError) {
      this.deps.onError?.(exchangeError, "token exchange failed");
      return this.fail({ kind: "failed" });
    }

    const missingScopes = REQUIRED_SCOPES.filter((s) => !tokens.scopes.includes(s));
    if (!tokens.scopes.includes("live.read")) {
      // 配信を検知できない連携は受け付けない。発行されたトークンは使わずに無効化する
      await this.deps.oauth.revoke(tokens.refreshToken).catch((revokeError: unknown) => {
        this.deps.onError?.(revokeError, "revoke failed");
      });
      return this.fail({ kind: "insufficient", missingScopes });
    }

    // 解除の途中に連携し直された場合は、解除が終わってから保存する
    await this.unlinking;
    const relinked = this.connection !== null;
    const connection = await this.deps.connections.save(tokens);
    await this.activate(connection);
    await this.log("linked", { relinked, missingScopes });

    await this.notify(
      [
        relinked ? "🔗 Spoonと連携し直しました。" : "🔗 Spoonと連携しました。",
        "推しの配信中に /join して、ボットが推しの配信に入れることを確かめてください。",
        ...missingScopeLines(missingScopes),
      ].join("\n"),
    );
    for (const listener of this.listeners) {
      await this.callListener(() => listener.onLinked?.(), "link listener failed");
    }
    return { kind: "linked", relinked, missingScopes };
  }

  // ---- 解除 ----

  /** 解除で削除するものの件数（確認メッセージ用）。連携していなければ null */
  async unlinkPreview(): Promise<{ targets: number; posts: number } | null> {
    const connection = this.connection;
    if (!connection) return null;
    const [targets, posts] = await Promise.all([
      this.deps.dajareTargets.list(connection.id),
      this.deps.dajarePosts.listAll(connection.id),
    ]);
    return { targets: targets.length, posts: posts.length };
  }

  /**
   * 連携を解除する（仕様書 §5.4）。退室、トークンの無効化（manual のときだけ）、
   * Discord のダジャレ投稿の削除、DB の削除を行う。連携していなければ null。
   * 同時に呼ばれたら、同じ解除の結果を返す
   */
  unlink(reason: UnlinkReason): Promise<UnlinkResult | null> {
    this.unlinking ??= this.doUnlink(reason).finally(() => {
      this.unlinking = null;
    });
    return this.unlinking;
  }

  private async doUnlink(reason: UnlinkReason): Promise<UnlinkResult | null> {
    const connection = this.connection;
    const manager = this.manager;
    if (!connection) return null;

    // 解除中に新しい API 呼び出しが始まらないよう、先に連携を外す
    await this.activate(null);
    for (const listener of this.listeners) {
      await this.callListener(() => listener.onUnlinking?.(), "unlink listener failed");
    }

    if (reason === "manual" && manager) {
      try {
        const tokens = await this.deps.connections.loadTokens(connection.id);
        await this.deps.oauth.revoke(tokens.refreshToken);
      } catch (error) {
        // 無効化できなくても削除は続ける（Spoon 側で連携を解除してもらう）
        this.deps.onError?.(error, "revoke failed");
      }
    }

    let deletedPosts = 0;
    let failedPosts = 0;
    for (const post of await this.deps.dajarePosts.listAll(connection.id)) {
      try {
        await this.deps.hooks.deleteDiscordMessage(post.channelId, post.messageId);
        deletedPosts++;
      } catch (error) {
        failedPosts++;
        this.deps.onError?.(error, "failed to delete dajare post");
      }
    }

    await this.deps.connections.delete(connection.id);
    await this.log("unlinked", { reason, deletedPosts, failedPosts });

    const lines =
      reason === "manual"
        ? ["🔌 Spoon連携を解除しました。トークンを無効にし、データを削除しました。"]
        : [
            "🔌 Spoon 側で連携が解除されていたため、データを削除しました。",
            "もう一度使うには、/link で推しに連携してもらってください。",
          ];
    lines.push(`削除したダジャレの投稿: ${deletedPosts}件`);
    if (failedPosts > 0) {
      lines.push(
        `⚠️ Discord から削除できなかった投稿が ${failedPosts}件あります。手動で削除してください。`,
      );
    }
    await this.notify(lines.join("\n"));
    return { reason, deletedPosts, failedPosts };
  }

  /**
   * API の呼び出しで連携の解除を検知したとき（TokenRevokedError）に呼ぶ。
   * それ以外のエラーは何もしない。解除を検知したら true
   */
  async handleError(error: unknown): Promise<boolean> {
    if (!(error instanceof TokenRevokedError)) return false;
    await this.unlink("revoked");
    return true;
  }

  // ---- 内部 ----

  private async activate(connection: SpoonConnection | null): Promise<void> {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    this.connection = connection;
    this.manager = null;
    if (!connection) return;

    const tokens = await this.deps.connections.loadTokens(connection.id);
    this.manager = new TokenManager(
      this.deps.oauth,
      tokens,
      this.deps.connections.persistence(connection.id),
      {
        clock: this.clock,
        onScopesReduced: (removed) => {
          void this.log("scopes_reduced", { removed });
          void this.notify(
            ["⚠️ 推しが Spoon で権限を減らしました。", ...missingScopeLines(removed)].join("\n"),
          );
        },
      },
    );
    this.keepAlive = setInterval(() => void this.refreshForKeepAlive(), KEEP_ALIVE_MS);
    this.keepAlive.unref();
  }

  private async refreshForKeepAlive(): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    try {
      await manager.refresh();
    } catch (error) {
      if (!(await this.handleError(error))) this.deps.onError?.(error, "keep-alive refresh failed");
    }
  }

  private async fail(result: CompleteResult): Promise<CompleteResult> {
    await this.log("link_failed", { result: result.kind });
    if (result.kind === "insufficient") {
      await this.notify(
        [
          "⚠️ 連携に必要な権限（配信の確認）が許可されなかったため、連携しませんでした。",
          "/link からやり直して、すべての権限を許可してもらってください。",
        ].join("\n"),
      );
    }
    return result;
  }

  private async notify(message: string): Promise<void> {
    try {
      await this.deps.hooks.notify(message);
    } catch (error) {
      this.deps.onError?.(error, "discord notify failed");
    }
  }

  private async log(
    type: string,
    detail: Record<string, string | number | boolean | string[]> = {},
  ) {
    try {
      await this.deps.logs.record(type, detail);
    } catch (error) {
      this.deps.onError?.(error, "failed to record log");
    }
  }

  private async callListener(fn: () => void | Promise<void>, context: string): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.onError?.(error, context);
    }
  }
}

function missingScopeLines(scopes: readonly string[]): string[] {
  if (scopes.length === 0) return [];
  return [
    "⚠️ 次の権限が許可されていないため、一部の機能が使えません。",
    ...scopes.map((s) => `・${s}: ${SCOPE_FEATURES[s] ?? s}`),
    "/link からやり直して、すべての権限を許可してもらってください。",
  ];
}

/** 32バイトの乱数（base64url、43文字） */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
