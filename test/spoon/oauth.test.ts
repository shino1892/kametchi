import { describe, expect, it } from "vitest";
import { SpoonOAuthError } from "../../src/spoon/errors.js";
import type { FetchLike } from "../../src/spoon/http.js";
import { SpoonOAuthClient } from "../../src/spoon/oauth.js";
import { FakeClock } from "../helpers/fake-clock.js";

const options = {
  baseUrl: "https://jp-openapi.spooncast.net",
  authorizeUrl: "https://developers.spooncast.net/jp/oauth/authorize",
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUri: "http://localhost:8787/callback",
};

// 公式ドキュメント「トークン」のレスポンス例
const tokenResponse = {
  access_token: "at_3f9c1e7b8d2a4056",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "rt_7b2e5a9c4f10d386",
  scope: "events.chat chat.send",
};

function recording(response: () => Response) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return response();
  };
  return { fetch, requests };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SpoonOAuthClient.authorizeUrl", () => {
  it("公式ドキュメントどおりのパラメータで同意画面の URL を作る", () => {
    const client = new SpoonOAuthClient(options);
    const url = new URL(client.authorizeUrl("state-xyz", ["live.read", "events.chat"]));

    expect(url.origin + url.pathname).toBe(options.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "http://localhost:8787/callback",
      scope: "live.read events.chat",
      state: "state-xyz",
    });
  });

  it("scope の空白を %20 でエンコードする", () => {
    const client = new SpoonOAuthClient(options);
    expect(client.authorizeUrl("s", ["live.read", "events.chat"])).toContain(
      "scope=live.read%20events.chat",
    );
  });

  it("既定では申請した4つの権限だけを要求する（仕様書 §3）", () => {
    const client = new SpoonOAuthClient(options);
    const scope = new URL(client.authorizeUrl("s")).searchParams.get("scope");
    expect(scope?.split(" ")).toEqual(["live.read", "events.chat", "events.like", "chat.send"]);
  });
});

describe("SpoonOAuthClient のトークン操作", () => {
  it("code を Basic 認証付きでトークンに交換する", async () => {
    const { fetch, requests } = recording(() => jsonResponse(200, tokenResponse));
    const clock = new FakeClock(1_000_000);
    const client = new SpoonOAuthClient({ ...options, fetch, clock });

    const tokens = await client.exchangeCode("code-1");

    expect(tokens).toEqual({
      accessToken: "at_3f9c1e7b8d2a4056",
      refreshToken: "rt_7b2e5a9c4f10d386",
      expiresAt: 1_000_000 + 3_600_000,
      scopes: ["events.chat", "chat.send"],
    });
    const request = requests[0];
    expect(request?.url).toBe("https://jp-openapi.spooncast.net/v1/oauth/token");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(request?.init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:8787/callback",
    });
  });

  it("refresh_token で更新する", async () => {
    const { fetch, requests } = recording(() => jsonResponse(200, tokenResponse));
    const client = new SpoonOAuthClient({ ...options, fetch });

    await client.refresh("rt_old");

    expect(Object.fromEntries(new URLSearchParams(String(requests[0]?.init?.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt_old",
    });
  });

  it("invalid_grant を SpoonOAuthError として返す", async () => {
    const { fetch } = recording(() =>
      jsonResponse(400, { error: "invalid_grant", error_description: "code is expired" }),
    );
    const client = new SpoonOAuthClient({ ...options, fetch });

    const error = await client.exchangeCode("old").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpoonOAuthError);
    expect(error).toMatchObject({
      status: 400,
      error: "invalid_grant",
      description: "code is expired",
    });
  });

  it("想定外のトークンレスポンスは拒否する", async () => {
    const { fetch } = recording(() => jsonResponse(200, { ...tokenResponse, token_type: "MAC" }));
    const client = new SpoonOAuthClient({ ...options, fetch });
    await expect(client.refresh("rt")).rejects.toMatchObject({ error: "invalid_response" });
  });

  it("revoke で token を送る", async () => {
    const { fetch, requests } = recording(() => new Response(null, { status: 200 }));
    const client = new SpoonOAuthClient({ ...options, fetch });

    await client.revoke("rt_1");

    expect(requests[0]?.url).toBe("https://jp-openapi.spooncast.net/v1/oauth/revoke");
    expect(String(requests[0]?.init?.body)).toBe("token=rt_1");
  });

  it("revoke の失敗は SpoonOAuthError として返す", async () => {
    const { fetch } = recording(() => jsonResponse(401, { error: "invalid_client" }));
    const client = new SpoonOAuthClient({ ...options, fetch });
    await expect(client.revoke("rt_1")).rejects.toMatchObject({ error: "invalid_client" });
  });
});
