import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { type CompleteResult, LINK_TTL_MS, type SpoonLink } from "../link/spoon-link.js";
import { type PrivacyContact, privacyPage } from "./privacy-view.js";
import {
  goToSpoonPage,
  invalidInvitePage,
  linkStartPage,
  messagePage,
  STYLESHEET,
} from "./views.js";

export interface WebAppDeps {
  link: Pick<SpoonLink, "isInviteUsable" | "startAuthorization" | "completeAuthorization">;
  /** 例: https://kametchi.com */
  baseUrl: string;
  /** https なら Cookie に Secure と __Host- を付ける */
  secureCookies: boolean;
  /** Spoon の Redirect URI（登録した値）。このパスでコールバックを受ける */
  spoonRedirectUri: string;
  privacy: PrivacyContact;
  /** 死活確認でデータベースに接続できるかを確かめる */
  healthCheck?: () => Promise<void>;
  onError?: (error: unknown, context: string) => void;
}

/**
 * 連携用のウェブ（仕様書 §5.2）。招待 URL の案内、Spoon の同意画面への送り出し、
 * コールバック、プライバシーポリシー、死活確認だけを持つ。
 *
 * - 招待は POST で初めて使う（Discord のリンクプレビューの GET で消費されないように）
 * - state はブラウザの Cookie に結びつけ、コールバックで同じブラウザかを確かめる
 * - Spoon のトークンはブラウザに渡さない
 */
export function createWebApp(deps: WebAppDeps): Hono {
  const app = new Hono();
  const origin = new URL(deps.baseUrl).origin;
  const secure = deps.secureCookies;
  const cookieName = secure ? "__Host-kametti_link" : "kametti_link";
  const callbackPath = new URL(deps.spoonRedirectUri).pathname;

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // フォームは自分のサイトにだけ送る。ブラウザはフォーム送信に続くリダイレクトにも
        // form-action を当てるため、Spoon の同意画面へはフォームの応答からリダイレクトしない
        // （同意画面は未ログインだと www.spooncast.net のログイン画面へさらに移る）
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      // コールバック URL の code を外部に送らない。no-referrer にすると、ブラウザは
      // 同じサイトへのフォーム送信でも Origin: null を送り、Origin の確認に通らなくなる
      referrerPolicy: "same-origin",
    }),
  );

  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
  });

  app.onError((error, c) => {
    deps.onError?.(error, `${c.req.method} ${c.req.path}`);
    return c.html(messagePage("エラーが発生しました", ["時間をおいてやり直してください。"]), 500);
  });

  app.get("/static/app.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(STYLESHEET);
  });

  app.get("/healthz", async (c) => {
    try {
      await deps.healthCheck?.();
      return c.text("ok");
    } catch (error) {
      deps.onError?.(error, "health check failed");
      return c.text("unavailable", 503);
    }
  });

  app.get("/privacy", (c) => c.html(privacyPage(deps.privacy)));

  app.get("/link/:token", async (c) => {
    const usable = await deps.link.isInviteUsable(c.req.param("token"));
    if (!usable) return c.html(invalidInvitePage(), 410);
    return c.html(linkStartPage(c.req.param("token")));
  });

  app.post("/link/:token", async (c) => {
    // 別のサイトからのフォーム送信を受け付けない（Origin: null も別のオリジンとして扱う）
    const requestOrigin = c.req.header("origin");
    if (requestOrigin !== undefined && requestOrigin !== origin) return c.text("Forbidden", 403);

    const started = await deps.link.startAuthorization(c.req.param("token"));
    if (!started) return c.html(invalidInvitePage(), 410);
    setCookie(c, cookieName, started.browserSecret, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: LINK_TTL_MS / 1000,
    });
    // フォーム送信とは別の移動にするため、リダイレクトではなく移動用のページを返す
    return c.html(goToSpoonPage(started.authorizeUrl));
  });

  app.get(callbackPath, async (c) => {
    const browserSecret = getCookie(c, cookieName);
    deleteCookie(c, cookieName, { path: "/", secure });
    const result = await deps.link.completeAuthorization({
      code: c.req.query("code"),
      state: c.req.query("state"),
      error: c.req.query("error"),
      browserSecret,
    });
    const [status, page] = resultPage(result);
    return c.html(page, status);
  });

  app.notFound((c) => c.html(messagePage("ページが見つかりません", []), 404));

  return app;
}

function resultPage(result: CompleteResult): [200 | 400 | 502, ReturnType<typeof messagePage>] {
  switch (result.kind) {
    case "linked":
      return [
        200,
        messagePage("連携しました", [
          "Spoon との連携が完了しました。このページは閉じてかまいません。",
          ...(result.missingScopes.length > 0
            ? [
                "ただし、許可されなかった権限があるため、一部の機能が使えません。詳しくは Discord をご確認ください。",
              ]
            : []),
        ]),
      ];
    case "denied":
      return [
        200,
        messagePage("連携しませんでした", [
          "Spoon の画面で同意されなかったため、連携していません。",
          "連携する場合は、Discord で /link を実行して、新しい URL を発行してもらってください。",
        ]),
      ];
    case "insufficient":
      return [
        400,
        messagePage("連携できませんでした", [
          "配信の確認の権限が許可されなかったため、連携していません。",
          "Discord で /link を実行して新しい URL を発行してもらい、すべての権限を許可してください。",
        ]),
      ];
    case "failed":
      return [
        502,
        messagePage("連携できませんでした", [
          "Spoon との通信に失敗しました。",
          "Discord で /link を実行して新しい URL を発行してもらい、もう一度お試しください。",
        ]),
      ];
    case "invalid":
      return [
        400,
        messagePage("この連携は無効です", [
          "期限（10分）が切れたか、URL を開いたブラウザと違うブラウザで戻ってきました。",
          "Discord で /link を実行して新しい URL を発行してもらい、同じブラウザで最後まで進めてください。",
        ]),
      ];
  }
}
