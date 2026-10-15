import { describe, expect, it } from "vitest";
import { SpoonApi } from "../../src/spoon/api.js";
import { type FetchLike, SpoonHttp } from "../../src/spoon/http.js";
import type { SseItem } from "../../src/spoon/sse.js";
import { FakeClock } from "../helpers/fake-clock.js";

const BASE = "https://jp-openapi.spooncast.net";

function api(handler: (url: URL, init: RequestInit | undefined) => Response) {
  const urls: URL[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    urls.push(url);
    return handler(url, init);
  };
  return {
    api: new SpoonApi(new SpoonHttp({ baseUrl: BASE, fetch, clock: new FakeClock() })),
    urls,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function collect(items: AsyncIterable<SseItem>): Promise<SseItem[]> {
  const result: SseItem[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe("SpoonApi.getLive", () => {
  it("公式ドキュメントのレスポンス例から liveId・タイトル・開始時刻を取り出す", async () => {
    const { api: client } = api(() =>
      json({
        liveId: 10001,
        title: "今夜の深夜ラジオ",
        startedAt: "2026-09-01T13:00:00Z",
        closeAirTime: "2026-09-01T15:00:00Z",
        listenerCount: 42,
        totalListenerCount: 137,
        welcomeMessage: "いらっしゃい！",
        isChatFrozen: false,
        categories: ["talk"],
        tags: ["深夜ラジオ"],
      }),
    );
    expect(await client.getLive("t")).toEqual({
      liveId: 10001,
      title: "今夜の深夜ラジオ",
      startedAt: Date.parse("2026-09-01T13:00:00Z"),
    });
  });

  it("配信していなければ isNotLive のエラーを投げる", async () => {
    const { api: client } = api(() =>
      json({ status: 404, detailCode: "OAPI_MNGR_0301", message: "not live" }, 404),
    );
    await expect(client.getLive("t")).rejects.toMatchObject({ isNotLive: true });
  });

  it("liveId がないレスポンスは拒否する", async () => {
    const { api: client } = api(() => json({ title: "x", startedAt: "2026-09-01T13:00:00Z" }));
    await expect(client.getLive("t")).rejects.toThrow("unexpected response");
  });
});

describe("SpoonApi.sendChat", () => {
  it("POST /v1/live/chat に message を JSON で送り、204 を成功とする", async () => {
    let method: string | undefined;
    let body: unknown;
    const { api: client, urls } = api((_, init) => {
      method = init?.method;
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    });
    await client.sendChat("t", "こんにちは");
    expect(method).toBe("POST");
    expect(urls[0]?.pathname).toBe("/v1/live/chat");
    expect(body).toEqual({ message: "こんにちは" });
  });

  it("チャットが凍結されていれば detailCode 付きのエラーを投げる", async () => {
    const { api: client } = api(() =>
      json({ status: 403, detailCode: "OAPI_MNGR_0208", message: "frozen" }, 403),
    );
    await expect(client.sendChat("t", "x")).rejects.toMatchObject({
      status: 403,
      detailCode: "OAPI_MNGR_0208",
    });
  });
});

describe("SpoonApi.connectEvents", () => {
  it("SSE の本文を項目として順に返す", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ":heartbeat\n\nid: 1-0\nevent: chat\nda",
      'ta: {"x":1}\n\nevent: end\ndata: {}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const { api: client } = api(
      () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const items = await collect(await client.connectEvents("t"));
    expect(items).toEqual([
      { type: "comment", text: "heartbeat" },
      { type: "event", event: "chat", data: '{"x":1}', id: "1-0" },
      { type: "event", event: "end", data: "{}", id: "1-0" },
    ]);
  });

  it("中断されたら、データを待っている途中でも読み取りを止める", async () => {
    // 何も送らず閉じもしないストリーム
    const body = new ReadableStream<Uint8Array>({});
    const { api: client } = api(
      () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );
    const controller = new AbortController();
    const items = await client.connectEvents("t", controller.signal);

    const reading = collect(items);
    controller.abort(new Error("stopped"));
    await expect(reading).rejects.toThrow("stopped");
  });

  it("接続に失敗したらエラーを投げる", async () => {
    const { api: client } = api(() =>
      json({ status: 403, detailCode: "OAPI_MNGR_0209", message: "blocked" }, 403),
    );
    await expect(client.connectEvents("t")).rejects.toMatchObject({
      status: 403,
      detailCode: "OAPI_MNGR_0209",
    });
  });
});
