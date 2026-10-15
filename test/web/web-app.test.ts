import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REQUIRED_SCOPES } from "../../src/spoon/oauth.js";
import { createWebApp } from "../../src/web/web-app.js";
import { APP_BASE_URL, setupLink } from "../helpers/link-fixture.js";
import { BASE_URL, REDIRECT_URI } from "../helpers/mock-spoon.js";

let t: Awaited<ReturnType<typeof setupLink>>;
let app: ReturnType<typeof createWebApp>;

beforeEach(async () => {
  t = await setupLink();
  app = createWebApp({
    link: t.link,
    baseUrl: APP_BASE_URL,
    secureCookies: false,
    spoonAuthorizeUrl: `${BASE_URL}/jp/oauth/authorize`,
    spoonRedirectUri: REDIRECT_URI,
    privacy: { x: "@example" },
    healthCheck: async () => {},
  });
});
afterEach(() => t.close());

const request = (path: string, init?: RequestInit) => app.request(`${APP_BASE_URL}${path}`, init);
const post = (path: string, headers: Record<string, string> = { Origin: APP_BASE_URL }) =>
  request(path, { method: "POST", headers });

async function newInvitePath(): Promise<string> {
  return new URL((await t.link.createInvite()).url).pathname;
}

/** Set-Cookie から Cookie ヘッダーの値を作る */
function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("連携用ページ", () => {
  it("招待の URL を開くと案内を表示し、何度開いても招待は使われない", async () => {
    const path = await newInvitePath();
    for (let i = 0; i < 2; i++) {
      const response = await request(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("DJ 本人の Spoon アカウント");
      expect(body).toContain("シークレットウィンドウ");
      expect(body).toContain(`action="${path}"`);
    }
  });

  it("使えない招待の URL は 410", async () => {
    expect((await request("/link/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(410);
    expect((await request("/link/abc")).status).toBe(410);
  });

  it("ボタンを押すと Cookie を付けて Spoon の同意画面へ送り、招待を使用済みにする", async () => {
    const path = await newInvitePath();
    const response = await post(path);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE_URL}/jp/oauth/authorize`);
    expect(location.searchParams.get("scope")).toBe(REQUIRED_SCOPES.join(" "));
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^kametti_link=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    expect((await request(path)).status).toBe(410);
    expect((await post(path)).status).toBe(410);
  });

  it("別のサイトからのフォーム送信は受け付けず、招待も使わない", async () => {
    const path = await newInvitePath();
    expect((await post(path, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(path, { Origin: "null" })).status).toBe(403);
    expect((await request(path)).status).toBe(200);
  });

  it("同意からコールバックまで通すと連携し、Cookie を消す", async () => {
    const start = await post(await newInvitePath());
    const callback = await t.consent(start.headers.get("location") ?? "");
    const query = new URLSearchParams({ code: callback.code ?? "", state: callback.state ?? "" });

    const response = await request(`/callback?${query}`, {
      headers: { Cookie: cookieOf(start) },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("連携しました");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(t.link.isLinked()).toBe(true);
  });

  it("Cookie のないブラウザで戻ってきたら連携しない", async () => {
    const start = await post(await newInvitePath());
    const callback = await t.consent(start.headers.get("location") ?? "");
    const query = new URLSearchParams({ code: callback.code ?? "", state: callback.state ?? "" });
    const response = await request(`/callback?${query}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("この連携は無効です");
    expect(t.link.isLinked()).toBe(false);
  });

  it("同意しなかったときは、その旨を表示する", async () => {
    const start = await post(await newInvitePath());
    const callback = await t.consent(start.headers.get("location") ?? "", { mock_deny: "1" });
    const query = new URLSearchParams({ error: callback.error ?? "", state: callback.state ?? "" });
    const response = await request(`/callback?${query}`, {
      headers: { Cookie: cookieOf(start) },
    });
    expect(await response.text()).toContain("同意されなかった");
    expect(t.link.isLinked()).toBe(false);
  });
});

describe("そのほかのページとヘッダー", () => {
  it("プライバシーポリシーに、Discord での処理と窓口を載せる", async () => {
    const body = await (await request("/privacy")).text();
    expect(body).toContain("Discord");
    expect(body).toContain("https://x.com/example");
  });

  it("healthz は ok を返す", async () => {
    const response = await request("/healthz");
    expect(await response.text()).toBe("ok");
  });

  it("ほかのパスは 404。連携の結果やトークンを返すページはない", async () => {
    for (const path of ["/", "/admin", "/api/tokens", "/link"]) {
      expect((await request(path)).status).toBe(404);
    }
  });

  it("CSP・Referrer-Policy・Cache-Control を付ける", async () => {
    const response = await request(await newInvitePath());
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`form-action 'self' ${BASE_URL}`);
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("https では Cookie に __Host- と Secure を付ける", async () => {
    const secureApp = createWebApp({
      link: t.link,
      baseUrl: "https://kametchi.com",
      secureCookies: true,
      spoonAuthorizeUrl: `${BASE_URL}/jp/oauth/authorize`,
      spoonRedirectUri: "https://kametchi.com/callback",
      privacy: {},
    });
    const path = await newInvitePath();
    const response = await secureApp.request(`https://kametchi.com${path}`, {
      method: "POST",
      headers: { Origin: "https://kametchi.com" },
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-kametti_link=/);
    expect(cookie).toContain("Secure");
  });
});
