import { describe, expect, it } from "vitest";
import { REQUIRED_SCOPES as REQUIRED_SCOPES_FOR_TEST } from "../../src/spoon/oauth.js";
import type { SseItem } from "../../src/spoon/sse.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { BASE_URL, REDIRECT_URI, setupMock } from "../helpers/mock-spoon.js";

const alice = { id: "alice", nickname: "アリス" };

/** ストリームから n 件の項目を読む */
async function take(items: AsyncIterable<SseItem>, n: number): Promise<SseItem[]> {
  const result: SseItem[] = [];
  if (n === 0) return result;
  for await (const item of items) {
    result.push(item);
    if (result.length >= n) break;
  }
  return result;
}

const eventsOf = (items: SseItem[]) =>
  items.flatMap((i) => (i.type === "event" ? [{ event: i.event, data: JSON.parse(i.data) }] : []));

describe("MockSpoon OAuth", () => {
  it("同意画面から code を受け取り、トークンに交換できる", async () => {
    const { authorize, oauth } = setupMock();
    const { code, state } = await authorize();
    expect(state).toBe("state-1");

    const tokens = await oauth.exchangeCode(code);
    expect(tokens.accessToken).toMatch(/^at_/);
    expect(tokens.scopes).toContain("events.chat");
  });

  it("code は1回しか使えない", async () => {
    const { authorize, oauth } = setupMock();
    const { code } = await authorize();
    await oauth.exchangeCode(code);
    await expect(oauth.exchangeCode(code)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("code は60秒で失効する", async () => {
    const clock = new FakeClock(0);
    const { authorize, oauth } = setupMock({ clock });
    const { code } = await authorize();
    clock.advance(60_000);
    await expect(oauth.exchangeCode(code)).rejects.toMatchObject({
      error: "invalid_grant",
      description: "code is expired",
    });
  });

  it("登録していない redirect_uri ではリダイレクトしない", async () => {
    const { mock } = setupMock();
    const url = new URL(`${BASE_URL}/jp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: `${REDIRECT_URI}/other`,
      scope: "live.read",
      state: "s",
    }).toString();
    const response = await mock.fetch(url.toString(), { redirect: "manual" });
    expect(response.status).toBe(400);
  });

  it("更新すると古い Refresh Token と Access Token が使えなくなる", async () => {
    const { connect, oauth, api, mock } = setupMock();
    mock.startLive();
    const first = await connect();
    const second = await oauth.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(oauth.refresh(first.refreshToken)).rejects.toMatchObject({
      error: "invalid_grant",
    });
    await expect(api.getLive(first.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(api.getLive(second.accessToken)).resolves.toMatchObject({ title: "テスト配信" });
  });

  it("revoke すると同じ連携のトークンがすべて使えなくなる", async () => {
    const { connect, oauth, api, mock } = setupMock();
    mock.startLive();
    const tokens = await connect();
    await oauth.revoke(tokens.refreshToken);
    await expect(api.getLive(tokens.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(oauth.refresh(tokens.refreshToken)).rejects.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("Client Secret が違えば invalid_client", async () => {
    const { authorize, mock } = setupMock();
    const { code } = await authorize();
    const response = await mock.fetch(`${BASE_URL}/v1/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("client-1:wrong").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client" });
  });
});

describe("MockSpoon API", () => {
  it("配信していなければ 404（OAPI_MNGR_0301）", async () => {
    const { connect, api } = setupMock();
    const tokens = await connect();
    await expect(api.getLive(tokens.accessToken)).rejects.toMatchObject({ isNotLive: true });
  });

  it("権限がなければ 403", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    const tokens = await connect(["events.chat"]);
    await expect(api.getLive(tokens.accessToken)).rejects.toMatchObject({ status: 403 });
  });

  it("注入した失敗を1回だけ返す", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    const tokens = await connect();
    mock.failNext("GET", "/v1/live", 429, null, { "Retry-After": "60" });
    await expect(api.getLive(tokens.accessToken)).rejects.toMatchObject({ retryAfterMs: 60_000 });
    await expect(api.getLive(tokens.accessToken)).resolves.toBeDefined();
  });
});

describe("MockSpoon イベントストリーム", () => {
  it("接続すると告知が投稿され、権限のあるイベントだけが届く", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    const tokens = await connect(["events.chat"]);
    const items = await api.connectEvents(tokens.accessToken);
    expect(mock.state().noticesPosted).toBe(1);

    expect(mock.like("dj-1", alice, "FREE")).toBe(0);
    expect(mock.chat("dj-1", alice, "hi")).toBe(1);
    mock.endLive();

    const received = eventsOf(await take(items, 2));
    expect(received.map((e) => e.event)).toEqual(["chat", "end"]);
    expect(received[0]?.data).toMatchObject({ user: alice, message: "hi", isDj: false });
    expect(received[1]?.data).toEqual({ reason: "LIVE_ENDED" });
  });

  it("同じ DJ に新しく接続すると、前の接続に DUPLICATE_CONNECTION が届く", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    const tokens = await connect();
    const first = await api.connectEvents(tokens.accessToken);
    await api.connectEvents(tokens.accessToken);

    expect(eventsOf(await take(first, 1))).toEqual([
      { event: "end", data: { reason: "DUPLICATE_CONNECTION" } },
    ]);
    expect(mock.state().streams).toBe(1);
  });

  it("イベントIDは {epochMillis}-{offset} 形式", async () => {
    const clock = new FakeClock(1_788_407_119_681);
    const { connect, api, mock } = setupMock({ clock });
    mock.startLive();
    const tokens = await connect();
    const items = await api.connectEvents(tokens.accessToken);
    mock.like("dj-1", alice, "FREE");
    mock.like("dj-1", alice, "PAID", 10);

    const ids = (await take(items, 2)).map((i) => (i.type === "event" ? i.id : null));
    expect(ids).toEqual(["1788407119681-0", "1788407119681-1"]);
  });

  it("ハートビートのコメント行が届く", async () => {
    const { connect, api, mock } = setupMock({ heartbeatMs: 5 });
    mock.startLive();
    const tokens = await connect();
    const items = await api.connectEvents(tokens.accessToken);
    expect(await take(items, 1)).toEqual([{ type: "comment", text: "heartbeat" }]);
  });

  it("ブロック中は 403（OAPI_MNGR_0209）で接続できない", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    mock.setBlocked("dj-1", true);
    const tokens = await connect();
    await expect(api.connectEvents(tokens.accessToken)).rejects.toMatchObject({
      status: 403,
      detailCode: "OAPI_MNGR_0209",
    });
  });

  it("DJ ごとに独立している", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive("dj-2");
    const dj1 = await connect(undefined, "dj-1");
    const dj2 = await connect(undefined, "dj-2");
    await expect(api.getLive(dj1.accessToken)).rejects.toMatchObject({ isNotLive: true });
    await expect(api.getLive(dj2.accessToken)).resolves.toMatchObject({ liveId: 10001 });
  });
});

describe("MockSpoon チャット送信", () => {
  it("chat.send の権限でボットとしてチャットを送れる", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    const tokens = await connect([...REQUIRED_SCOPES_FOR_TEST]);
    await api.sendChat(tokens.accessToken, "こんにちは");
    expect(mock.sentChats()).toEqual(["こんにちは"]);
  });

  it("権限がない・凍結・空・長すぎるときは公式のエラーを返す", async () => {
    const { connect, api, mock } = setupMock();
    mock.startLive();
    const without = await connect(REQUIRED_SCOPES_FOR_TEST.filter((s) => s !== "chat.send"));
    await expect(api.sendChat(without.accessToken, "x")).rejects.toMatchObject({ status: 403 });

    const tokens = await connect([...REQUIRED_SCOPES_FOR_TEST]);
    await expect(api.sendChat(tokens.accessToken, "   ")).rejects.toMatchObject({
      detailCode: "OAPI_MNGR_0108",
    });
    await expect(api.sendChat(tokens.accessToken, "🍊".repeat(101))).rejects.toMatchObject({
      detailCode: "OAPI_MNGR_0109",
    });
    mock.setChatFrozen("dj-1", true);
    await expect(api.sendChat(tokens.accessToken, "x")).rejects.toMatchObject({
      status: 403,
      detailCode: "OAPI_MNGR_0208",
    });
    expect(mock.sentChats()).toEqual([]);
  });
});

describe("MockSpoon 同意画面", () => {
  it("mock_deny を付けると、同意しなかったときの error を返す", async () => {
    const { mock, oauth } = setupMock();
    const url = new URL(oauth.authorizeUrl("s"));
    url.searchParams.set("mock_deny", "1");
    const response = await mock.fetch(url.toString(), { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("s");
    expect(location.searchParams.has("code")).toBe(false);
  });
});
