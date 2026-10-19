import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import type { Listener } from "../spoon/events.js";
import type { FetchLike } from "../spoon/http.js";

/**
 * Spoon Developers API のモック。公式ドキュメント（v1.1.0）の挙動を再現し、
 * 運用承認前の開発とテストで本物の代わりに使う（Spoon Listener Lens のモックを、
 * kametchi が使う API だけに絞ったもの。仕様書 §3）。
 *
 * 再現する主な挙動:
 * - OAuth: code は60秒・1回限り、redirect_uri の完全一致、Refresh Token の回転、revoke
 * - GET /v1/live、POST /v1/live/chat（200文字・絵文字2文字、凍結、空白のみ）
 * - GET /v1/live/events: 同一DJへの接続は1本、ハートビート、権限ごとのイベント配信
 * - 公式形式のエラーレスポンスと detailCode
 *
 * テストやローカル操作のため、/__mock 以下に操作用のエンドポイントを持つ。
 */

export interface MockClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  /** アプリに登録した権限 */
  scopes: string[];
}

export interface MockSpoonOptions {
  clients: MockClient[];
  now?: () => number;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  codeTtlSec?: number;
  heartbeatMs?: number;
}

interface LiveState {
  liveId: number;
  title: string;
  startedAt: number;
}

interface StreamConnection {
  grant: Grant;
  send(chunk: string): void;
  close(): void;
}

interface DjState {
  id: string;
  live: LiveState | null;
  botBlocked: boolean;
  /** チャットが凍結されている（送信は 403 OAPI_MNGR_0208） */
  chatFrozen: boolean;
  /** ボットが送ったチャット（ストリームには流さない） */
  sentChats: string[];
  streams: Set<StreamConnection>;
  noticesPosted: number;
}

interface Grant {
  clientId: string;
  djId: string;
  scopes: Set<string>;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

interface PendingCode {
  clientId: string;
  djId: string;
  scopes: string[];
  redirectUri: string;
  expiresAt: number;
}

interface InjectedFailure {
  method: string;
  path: string;
  status: number;
  detailCode: string | null;
  headers: Record<string, string>;
}

export const DEFAULT_DJ = "dj-1";

const EVENT_SCOPES: Record<string, string> = {
  chat: "events.chat",
  like: "events.like",
};

const ERROR_MESSAGES: Record<string, string> = {
  OAPI_MNGR_0208: "Chat is not available.",
  OAPI_MNGR_0209: "The DJ has blocked this bot from entering.",
  OAPI_MNGR_0301: "The DJ is not broadcasting right now.",
};

export class MockSpoon {
  readonly app = new Hono();
  /** MockSpoon を相手にする fetch。ネットワークを使わずに app へ渡す */
  readonly fetch: FetchLike = async (input, init) => this.app.fetch(new Request(input, init));

  private readonly clients: Map<string, MockClient>;
  private readonly now: () => number;
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;
  private readonly codeTtlMs: number;
  private readonly heartbeatMs: number;

  private readonly djs = new Map<string, DjState>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly byAccess = new Map<string, Grant>();
  private readonly byRefresh = new Map<string, Grant>();
  private readonly failures: InjectedFailure[] = [];
  private nextLiveId = 10001;
  private lastEventMs = 0;
  private eventOffset = 0;

  constructor(options: MockSpoonOptions) {
    this.clients = new Map(options.clients.map((c) => [c.clientId, c]));
    this.now = options.now ?? Date.now;
    this.accessTtlMs = (options.accessTokenTtlSec ?? 3600) * 1000;
    this.refreshTtlMs = (options.refreshTokenTtlSec ?? 30 * 24 * 3600) * 1000;
    this.codeTtlMs = (options.codeTtlSec ?? 60) * 1000;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.routes();
  }

  // ---- 操作（テスト・ローカル確認用） ----

  /** 配信を始める */
  startLive(djId = DEFAULT_DJ, title = "テスト配信", startedAt = this.now()): number {
    const dj = this.dj(djId);
    dj.live = { liveId: this.nextLiveId++, title, startedAt };
    return dj.live.liveId;
  }

  /** 配信を終える。接続中のストリームには LIVE_ENDED を送って閉じる */
  endLive(djId = DEFAULT_DJ): void {
    const dj = this.dj(djId);
    this.endStreams(dj, "LIVE_ENDED");
    dj.live = null;
  }

  /** TOKEN_EXPIRED・RECONNECT などでストリームを閉じる */
  endStreams(djOrId: DjState | string, reason: string): void {
    const dj = typeof djOrId === "string" ? this.dj(djOrId) : djOrId;
    for (const stream of [...dj.streams]) {
      stream.send(this.eventChunk("end", { reason }));
      stream.close();
    }
  }

  /** end を送らずにストリームを切る（通信断の再現） */
  dropStreams(djId = DEFAULT_DJ): void {
    for (const stream of [...this.dj(djId).streams]) stream.close();
  }

  /** イベントを配信する。権限に応じて届いた接続の数を返す */
  emit(djId: string, event: string, payload: unknown): number {
    const dj = this.dj(djId);
    const scope = EVENT_SCOPES[event];
    if (!scope) throw new Error(`unknown event: ${event}`);

    const chunk = this.eventChunk(event, payload);
    let delivered = 0;
    for (const stream of dj.streams) {
      if (!stream.grant.scopes.has(scope)) continue;
      stream.send(chunk);
      delivered++;
    }
    return delivered;
  }

  /** リスナー（または DJ）のチャットを配信する */
  chat(djId: string, user: Listener, message: string, isDj = false): number {
    return this.emit(djId, "chat", {
      user,
      message,
      isDj,
      sentTime: new Date(this.now()).toISOString(),
    });
  }

  /** ハートを配信する。totalAmount は (amount + extraAmount) × combo */
  like(djId: string, user: Listener, type: "FREE" | "PAID", totalAmount = 1): number {
    return this.emit(djId, "like", {
      user,
      type,
      amount: totalAmount,
      extraAmount: 0,
      combo: 1,
      totalAmount,
      time: new Date(this.now()).toISOString(),
    });
  }

  /** DJ がボットをブロックしたか */
  setBlocked(djId: string, value: boolean): void {
    this.dj(djId).botBlocked = value;
  }

  /** チャットを凍結する */
  setChatFrozen(djId: string, value: boolean): void {
    this.dj(djId).chatFrozen = value;
  }

  /** ボットが送ったチャット */
  sentChats(djId = DEFAULT_DJ): string[] {
    return [...this.dj(djId).sentChats];
  }

  /** DJ がコンソールで連携を解除した状態にする */
  revokeDj(djId: string): void {
    for (const grant of [...this.byAccess.values()]) {
      if (grant.djId === djId) this.deleteGrant(grant);
    }
  }

  /** すべての Access Token を失効させる */
  expireAccessTokens(): void {
    for (const grant of this.byAccess.values()) grant.accessExpiresAt = this.now() - 1;
  }

  /** 有効なトークンの組の数（revoke の確認用） */
  activeGrants(): number {
    return this.byRefresh.size;
  }

  /** 次に一致したリクエストを指定のエラーで失敗させる */
  failNext(
    method: string,
    path: string,
    status: number,
    detailCode: string | null = null,
    headers: Record<string, string> = {},
  ): void {
    this.failures.push({ method, path, status, detailCode, headers });
  }

  state(djId = DEFAULT_DJ) {
    const dj = this.dj(djId);
    return {
      live: dj.live,
      streams: dj.streams.size,
      noticesPosted: dj.noticesPosted,
      botBlocked: dj.botBlocked,
      chatFrozen: dj.chatFrozen,
      sentChats: dj.sentChats.length,
    };
  }

  // ---- 内部 ----

  private dj(id: string): DjState {
    let dj = this.djs.get(id);
    if (!dj) {
      dj = {
        id,
        live: null,
        botBlocked: false,
        chatFrozen: false,
        sentChats: [],
        streams: new Set(),
        noticesPosted: 0,
      };
      this.djs.set(id, dj);
    }
    return dj;
  }

  private eventChunk(event: string, payload: unknown): string {
    const now = this.now();
    if (now === this.lastEventMs) {
      this.eventOffset++;
    } else {
      this.lastEventMs = now;
      this.eventOffset = 0;
    }
    return `id:${now}-${this.eventOffset}\nevent:${event}\ndata:${JSON.stringify(payload)}\n\n`;
  }

  private issueGrant(clientId: string, djId: string, scopes: Iterable<string>): Grant {
    const now = this.now();
    const grant: Grant = {
      clientId,
      djId,
      scopes: new Set(scopes),
      accessToken: `at_${randomBytes(12).toString("hex")}`,
      accessExpiresAt: now + this.accessTtlMs,
      refreshToken: `rt_${randomBytes(12).toString("hex")}`,
      refreshExpiresAt: now + this.refreshTtlMs,
    };
    this.byAccess.set(grant.accessToken, grant);
    this.byRefresh.set(grant.refreshToken, grant);
    return grant;
  }

  private deleteGrant(grant: Grant): void {
    this.byAccess.delete(grant.accessToken);
    this.byRefresh.delete(grant.refreshToken);
  }

  private tokenResponse(grant: Grant) {
    return {
      access_token: grant.accessToken,
      token_type: "Bearer",
      expires_in: Math.round((grant.accessExpiresAt - this.now()) / 1000),
      refresh_token: grant.refreshToken,
      scope: [...grant.scopes].join(" "),
    };
  }

  private apiError(c: Context, status: number, detailCode: string | null = null) {
    const titles: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
    };
    return c.json(
      {
        instance: c.req.path,
        status,
        title: titles[status] ?? "Error",
        detailCode,
        message: (detailCode && ERROR_MESSAGES[detailCode]) ?? titles[status] ?? "Error",
        userId: null,
        extra: null,
        timestamp: this.now(),
      },
      status as 400,
    );
  }

  private oauthError(c: Context, status: number, error: string, description?: string) {
    return c.json(
      description ? { error, error_description: description } : { error },
      status as 400,
    );
  }

  /** Basic 認証またはフォームの client_id / client_secret でクライアントを確認する */
  private authenticateClient(c: Context, form: Record<string, string>): MockClient | null {
    let clientId = form.client_id;
    let clientSecret = form.client_secret;
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      clientId = decoded.slice(0, sep);
      clientSecret = decoded.slice(sep + 1);
    }
    const client = clientId ? this.clients.get(clientId) : undefined;
    return client && client.clientSecret === clientSecret ? client : null;
  }

  private bearer(c: Context): Grant | null {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return null;
    const grant = this.byAccess.get(auth.slice(7));
    if (!grant || grant.accessExpiresAt <= this.now()) return null;
    return grant;
  }

  private routes(): void {
    const app = this.app;

    // 注入された失敗を先に返す
    app.use("*", async (c, next) => {
      const index = this.failures.findIndex(
        (f) => f.method === c.req.method && f.path === c.req.path,
      );
      const failure = index === -1 ? undefined : this.failures.splice(index, 1)[0];
      if (!failure) return next();
      for (const [key, value] of Object.entries(failure.headers)) c.header(key, value);
      if (failure.status === 429 && failure.detailCode === null) {
        return c.body(null, 429);
      }
      return this.apiError(c, failure.status, failure.detailCode);
    });

    // ---- OAuth ----

    app.get("/:region/oauth/authorize", (c) => {
      const q = c.req.query();
      const client = q.client_id ? this.clients.get(q.client_id) : undefined;
      if (!client) return c.text("unknown client_id", 400);
      if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
        // 公式: 一致しなければ同意画面にエラーが出て、リダイレクトしない
        return c.text("redirect_uri does not match", 400);
      }
      if (q.response_type !== "code") return c.text("response_type must be code", 400);
      const scopes = (q.scope ?? "").split(" ").filter((s) => s !== "");
      if (scopes.length === 0 || scopes.some((s) => !client.scopes.includes(s))) {
        return c.text("invalid scope", 400);
      }

      const redirect = new URL(q.redirect_uri);
      if (q.state) redirect.searchParams.set("state", q.state);
      // mock_deny=1 で、DJ が同意しなかった場合を再現する
      if (q.mock_deny) {
        redirect.searchParams.set("error", "access_denied");
        return c.redirect(redirect.toString(), 302);
      }

      // モックでは DJ の同意を省略し、mock_dj で指定した DJ として即座に同意する
      const djId = q.mock_dj ?? DEFAULT_DJ;
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, {
        clientId: client.clientId,
        djId,
        scopes,
        redirectUri: q.redirect_uri,
        expiresAt: this.now() + this.codeTtlMs,
      });
      redirect.searchParams.set("code", code);
      return c.redirect(redirect.toString(), 302);
    });

    app.post("/v1/oauth/token", async (c) => {
      const form = Object.fromEntries(
        Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
      );
      const client = this.authenticateClient(c, form);
      if (!client) return this.oauthError(c, 401, "invalid_client");

      if (form.grant_type === "authorization_code") {
        if (!form.code || !form.redirect_uri) return this.oauthError(c, 400, "invalid_request");
        const pending = this.codes.get(form.code);
        this.codes.delete(form.code);
        if (!pending || pending.clientId !== client.clientId) {
          return this.oauthError(c, 400, "invalid_grant", "code is invalid");
        }
        if (pending.expiresAt <= this.now()) {
          return this.oauthError(c, 400, "invalid_grant", "code is expired");
        }
        if (pending.redirectUri !== form.redirect_uri) {
          return this.oauthError(c, 400, "invalid_grant", "redirect_uri does not match");
        }
        return c.json(
          this.tokenResponse(this.issueGrant(client.clientId, pending.djId, pending.scopes)),
        );
      }

      if (form.grant_type === "refresh_token") {
        if (!form.refresh_token) return this.oauthError(c, 400, "invalid_request");
        const grant = this.byRefresh.get(form.refresh_token);
        if (!grant || grant.clientId !== client.clientId || grant.refreshExpiresAt <= this.now()) {
          return this.oauthError(c, 400, "invalid_grant", "refresh token is invalid");
        }
        // 古いペアは直ちに失効させる
        this.deleteGrant(grant);
        return c.json(
          this.tokenResponse(this.issueGrant(client.clientId, grant.djId, grant.scopes)),
        );
      }

      return this.oauthError(c, 400, "unsupported_grant_type");
    });

    app.post("/v1/oauth/revoke", async (c) => {
      const form = Object.fromEntries(
        Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
      );
      const client = this.authenticateClient(c, form);
      if (!client) return this.oauthError(c, 401, "invalid_client");
      if (!form.token) return this.oauthError(c, 400, "invalid_request");
      // RFC 7009: 存在しないトークンでも 200
      const grant = this.byRefresh.get(form.token) ?? this.byAccess.get(form.token);
      if (grant && grant.clientId === client.clientId) this.deleteGrant(grant);
      return c.body(null, 200);
    });

    // ---- API ----

    app.get("/v1/live", (c) => {
      const grant = this.bearer(c);
      if (!grant) return this.apiError(c, 401);
      if (!grant.scopes.has("live.read")) return this.apiError(c, 403);
      const dj = this.dj(grant.djId);
      if (!dj.live) return this.apiError(c, 404, "OAPI_MNGR_0301");
      return c.json({
        liveId: dj.live.liveId,
        title: dj.live.title,
        startedAt: new Date(dj.live.startedAt).toISOString(),
        closeAirTime: new Date(dj.live.startedAt + 2 * 3600_000).toISOString(),
        listenerCount: 0,
        totalListenerCount: 0,
        welcomeMessage: "",
        isChatFrozen: dj.chatFrozen,
        categories: [],
        tags: [],
      });
    });

    app.post("/v1/live/chat", async (c) => {
      const grant = this.bearer(c);
      if (!grant) return this.apiError(c, 401);
      if (!grant.scopes.has("chat.send")) return this.apiError(c, 403);
      const dj = this.dj(grant.djId);
      if (!dj.live) return this.apiError(c, 404, "OAPI_MNGR_0301");
      if (dj.chatFrozen || dj.botBlocked) return this.apiError(c, 403, "OAPI_MNGR_0208");

      const body = (await c.req.json().catch(() => null)) as { message?: unknown } | null;
      if (!body || typeof body.message !== "string") return this.apiError(c, 400, "OAPI_MNGR_0103");
      if (body.message.trim() === "") return this.apiError(c, 400, "OAPI_MNGR_0108");
      // 絵文字は2文字として数える
      let length = 0;
      for (const char of body.message) length += (char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      if (length > 200) return this.apiError(c, 400, "OAPI_MNGR_0109");

      dj.sentChats.push(body.message);
      return c.body(null, 204);
    });

    app.get("/v1/live/events", (c) => {
      const grant = this.bearer(c);
      if (!grant) return this.apiError(c, 401);
      if (![...grant.scopes].some((s) => s.startsWith("events."))) return this.apiError(c, 403);
      const dj = this.dj(grant.djId);
      if (!dj.live) return this.apiError(c, 404, "OAPI_MNGR_0301");
      if (dj.botBlocked) return this.apiError(c, 403, "OAPI_MNGR_0209");

      // 同じ DJ への接続はひとつだけ。前の接続を閉じる
      this.endStreams(dj, "DUPLICATE_CONNECTION");

      const encoder = new TextEncoder();
      let connection: StreamConnection | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        clearInterval(heartbeat);
        if (connection) dj.streams.delete(connection);
      };

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          let closed = false;
          connection = {
            grant,
            send: (chunk) => {
              if (!closed) controller.enqueue(encoder.encode(chunk));
            },
            close: () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            },
          };
          dj.streams.add(connection);
          // 接続した瞬間にボット名でリスナーへの告知が投稿される
          dj.noticesPosted++;
          heartbeat = setInterval(() => connection?.send(":heartbeat\n\n"), this.heartbeatMs);
          heartbeat.unref();
        },
        cancel: cleanup,
      });

      return new Response(body, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    });

    // ---- 操作用エンドポイント（モック専用） ----

    app.get("/__mock/state", (c) => c.json(this.state(c.req.query("dj") ?? DEFAULT_DJ)));

    app.post("/__mock/:action", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const djId = typeof body.dj === "string" ? body.dj : DEFAULT_DJ;
      const listener = (): Listener => ({
        id: String(body.id ?? "l1"),
        nickname: typeof body.nickname === "string" ? body.nickname : null,
      });

      switch (c.req.param("action")) {
        case "start-live":
          return c.json({
            liveId: this.startLive(djId, typeof body.title === "string" ? body.title : undefined),
          });
        case "end-live":
          this.endLive(djId);
          break;
        case "chat":
          return c.json({
            delivered: this.chat(djId, listener(), String(body.message ?? ""), body.isDj === true),
          });
        case "like":
          return c.json({
            delivered: this.like(
              djId,
              listener(),
              body.type === "PAID" ? "PAID" : "FREE",
              typeof body.totalAmount === "number" ? body.totalAmount : 1,
            ),
          });
        case "blocked":
          this.setBlocked(djId, body.value !== false);
          break;
        case "chat-frozen":
          this.setChatFrozen(djId, body.value !== false);
          break;
        case "end-streams":
          this.endStreams(djId, String(body.reason ?? "RECONNECT"));
          break;
        case "drop-streams":
          this.dropStreams(djId);
          break;
        case "revoke":
          this.revokeDj(djId);
          break;
        case "expire-tokens":
          this.expireAccessTokens();
          break;
        default:
          return c.text("unknown action", 404);
      }
      return c.json(this.state(djId));
    });
  }
}
