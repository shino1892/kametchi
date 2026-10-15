import { describe, expect, it } from "vitest";
import { SpoonApiError } from "../../src/spoon/errors.js";
import {
  ALLOWED_ENDPOINTS,
  EndpointNotAllowedError,
  type FetchLike,
  type RateLimitInfo,
  SpoonHttp,
} from "../../src/spoon/http.js";
import { FakeClock } from "../helpers/fake-clock.js";

const BASE = "https://jp-openapi.spooncast.net";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorBody(status: number, detailCode: string | null, message: string) {
  return {
    instance: "/v1/live",
    status,
    title: "",
    detailCode,
    message,
    userId: null,
    extra: null,
  };
}

/** 決められた順にレスポンスを返す fetch。受け取ったリクエストを記録する */
function scripted(responses: Array<Response | Error>) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, requests };
}

function client(fetch: FetchLike, extra: { onRateLimit?: (info: RateLimitInfo) => void } = {}) {
  const clock = new FakeClock();
  const http = new SpoonHttp({ baseUrl: `${BASE}/`, fetch, clock, maxRetries: 3, ...extra });
  return { http, clock };
}

describe("SpoonHttp.requestJson", () => {
  it("Bearer トークンとクエリを付けて呼び、JSON を返す", async () => {
    const { fetch, requests } = scripted([json(200, { liveId: 1 })]);
    const { http } = client(fetch);

    const body = await http.requestJson("GET", "/v1/live", "at_1", {
      query: { x: "abc" },
    });

    expect(body).toEqual({ liveId: 1 });
    expect(requests[0]?.url).toBe(`${BASE}/v1/live?x=abc`);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer at_1");
  });

  it("204 は undefined を返す", async () => {
    const { fetch } = scripted([new Response(null, { status: 204 })]);
    const { http } = client(fetch);
    expect(
      await http.requestJson("POST", "/v1/live/chat", "at_1", { json: { message: "x" } }),
    ).toBeUndefined();
  });

  it("エラーレスポンスの detailCode と message を SpoonApiError にする", async () => {
    const { fetch } = scripted([
      json(404, errorBody(404, "OAPI_MNGR_0301", "The DJ is not broadcasting right now.")),
    ]);
    const { http } = client(fetch);

    const error = await http.requestJson("GET", "/v1/live", "at_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpoonApiError);
    expect(error).toMatchObject({
      status: 404,
      detailCode: "OAPI_MNGR_0301",
      message: "The DJ is not broadcasting right now.",
      isNotLive: true,
    });
  });

  it("401・403・404 は再試行しない", async () => {
    for (const status of [401, 403, 404]) {
      const { fetch, requests } = scripted([json(status, errorBody(status, null, "x"))]);
      const { http } = client(fetch);
      await expect(http.requestJson("GET", "/v1/live", "t")).rejects.toBeInstanceOf(SpoonApiError);
      expect(requests).toHaveLength(1);
    }
  });

  it("秒単位の 429（本文・Retry-After なし）と 5xx は指数バックオフで再試行する", async () => {
    const { fetch, requests } = scripted([
      new Response(null, { status: 429 }),
      json(500, errorBody(500, "OAPI_MNGR_1002", "server")),
      json(502, errorBody(502, "OAPI_MNGR_2302", "live server")),
      json(200, { ok: true }),
    ]);
    const { http, clock } = client(fetch);

    expect(await http.requestJson("GET", "/v1/live", "t")).toEqual({ ok: true });
    expect(requests).toHaveLength(4);
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  it("再試行の上限を超えたら最後のエラーを返す", async () => {
    const { fetch, requests } = scripted(
      Array.from({ length: 4 }, () => new Response(null, { status: 429 })),
    );
    const { http } = client(fetch);
    await expect(http.requestJson("GET", "/v1/live", "t")).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(4);
  });

  it("1日あたりの上限超過（429 + Retry-After）は再試行せず、待機時間を返す", async () => {
    const { fetch, requests } = scripted([
      new Response(null, { status: 429, headers: { "Retry-After": "3600" } }),
    ]);
    const { http } = client(fetch);

    const error = await http.requestJson("GET", "/v1/live", "t").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 3_600_000, isDailyRateLimited: true });
    expect(requests).toHaveLength(1);
  });

  it("通信エラーは再試行する", async () => {
    const { fetch, requests } = scripted([new TypeError("fetch failed"), json(200, { ok: 1 })]);
    const { http } = client(fetch);
    expect(await http.requestJson("GET", "/v1/live", "t")).toEqual({ ok: 1 });
    expect(requests).toHaveLength(2);
  });

  it("中断されたら再試行しない", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const { fetch, requests } = scripted([new TypeError("aborted")]);
    const { http } = client(fetch);
    await expect(
      http.requestJson("GET", "/v1/live", "t", { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(requests).toHaveLength(1);
  });

  it("JSON 本文を Content-Type 付きで送る", async () => {
    const { fetch, requests } = scripted([new Response(null, { status: 204 })]);
    const { http } = client(fetch);
    await http.requestJson("POST", "/v1/live/chat", "t", { json: { message: "hi" } });
    expect(requests[0]?.init?.body).toBe('{"message":"hi"}');
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("レート制限ヘッダーを通知する", async () => {
    const infos: RateLimitInfo[] = [];
    const { fetch } = scripted([
      json(
        200,
        {},
        {
          "x-ratelimit-remaining": "9",
          "x-ratelimit-daily-limit": "10000",
          "x-ratelimit-daily-remaining": "9876",
        },
      ),
    ]);
    const { http } = client(fetch, { onRateLimit: (info) => infos.push(info) });
    await http.requestJson("GET", "/v1/live", "t");
    expect(infos).toEqual([
      { path: "/v1/live", remaining: 9, dailyLimit: 10000, dailyRemaining: 9876 },
    ]);
  });
});

describe("SpoonHttp.openStream", () => {
  it("Accept: text/event-stream で開き、本文のストリームを返す", async () => {
    const { fetch, requests } = scripted([
      new Response(":heartbeat\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    ]);
    const { http } = client(fetch);
    const stream = await http.openStream("/v1/live/events", "t");
    expect(await new Response(stream).text()).toBe(":heartbeat\n\n");
    expect(new Headers(requests[0]?.init?.headers).get("accept")).toBe("text/event-stream");
  });

  it("失敗しても再試行せずにエラーを返す", async () => {
    const { fetch, requests } = scripted([new Response(null, { status: 502 })]);
    const { http } = client(fetch);
    await expect(http.openStream("/v1/live/events", "t")).rejects.toMatchObject({ status: 502 });
    expect(requests).toHaveLength(1);
  });
});

describe("認可された API だけを呼ぶ（仕様書 §3）", () => {
  it("許可している API は GET /v1/live、GET /v1/live/events、POST /v1/live/chat の3つだけ", () => {
    expect([...ALLOWED_ENDPOINTS].sort()).toEqual([
      "GET /v1/live",
      "GET /v1/live/events",
      "POST /v1/live/chat",
    ]);
  });

  it.each([
    ["GET", "/v1/live/listeners"],
    ["GET", "/v1/live/fans"],
    ["POST", "/v1/live/follow"],
    ["POST", "/v1/live"],
    ["GET", "/v1/live/chat"],
    ["GET", "/v1/live/../live/listeners"],
    ["GET", "/v2/live"],
  ] as const)("%s %s は送信する前に拒否する", async (method, path) => {
    const { fetch, requests } = scripted([json(200, {})]);
    const { http } = client(fetch);
    await expect(http.requestJson(method, path, "at_1")).rejects.toBeInstanceOf(
      EndpointNotAllowedError,
    );
    expect(requests).toHaveLength(0);
  });

  it("ストリームも /v1/live/events 以外は開かない", async () => {
    const { fetch, requests } = scripted([json(200, {})]);
    const { http } = client(fetch);
    await expect(http.openStream("/v1/live/listeners", "at_1")).rejects.toBeInstanceOf(
      EndpointNotAllowedError,
    );
    expect(requests).toHaveLength(0);
  });
});
