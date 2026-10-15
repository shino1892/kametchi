import { describe, expect, it } from "vitest";
import { ChatSender } from "../../src/chat/chat-sender.js";
import { SpoonApiError, TokenRevokedError } from "../../src/spoon/errors.js";
import { FakeClock } from "../helpers/fake-clock.js";

/** 送信のたびに、決めた順に結果を返す（undefined は成功） */
function setup(results: Array<Error | undefined> = [], options: { joined?: boolean } = {}) {
  const clock = new FakeClock(0);
  const sent: string[] = [];
  const unlinked: unknown[] = [];
  let joined = options.joined ?? true;
  const sender = new ChatSender(
    {
      send: async (message) => {
        const next = results.shift();
        if (next) throw next;
        sent.push(message);
      },
      canSend: () => joined,
      onUnlinked: (error) => void unlinked.push(error),
    },
    { clock, minIntervalMs: 1_500, rateLimitedWaitMs: 5_000, maxQueue: 3 },
  );
  return { clock, sender, sent, unlinked, setJoined: (value: boolean) => (joined = value) };
}

const apiError = (status: number, detailCode: string | null = null) =>
  new SpoonApiError(status, detailCode, "error");

describe("ChatSender", () => {
  it("1件ずつ、1.5秒以上の間隔を空けて送り、結果を返す", async () => {
    const t = setup();
    const results = await Promise.all([t.sender.send("a"), t.sender.send("b")]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(t.sent).toEqual(["a", "b"]);
    expect(t.clock.sleeps).toEqual([1_500, 1_500]);
  });

  it("送信過多（429 OAPI_MNGR_0302）なら5秒待って1回だけ送り直す", async () => {
    const t = setup([apiError(429, "OAPI_MNGR_0302")]);
    expect(await t.sender.send("a")).toEqual({ ok: true });
    expect(t.clock.sleeps[0]).toBe(5_000);

    const again = setup([apiError(429, "OAPI_MNGR_0302"), apiError(429, "OAPI_MNGR_0302")]);
    expect(await again.sender.send("a")).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("チャットが凍結されていたら（403 OAPI_MNGR_0208）、待っている分も送らない", async () => {
    const t = setup([apiError(403, "OAPI_MNGR_0208")]);
    const results = await Promise.all([t.sender.send("a"), t.sender.send("b")]);
    expect(results).toEqual([
      { ok: false, reason: "chat_unavailable" },
      { ok: false, reason: "chat_unavailable" },
    ]);
    expect(t.sent).toEqual([]);
  });

  it("配信していなければ（404）、待っている分も送らない", async () => {
    const t = setup([apiError(404, "OAPI_MNGR_0301")]);
    const results = await Promise.all([t.sender.send("a"), t.sender.send("b")]);
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["not_live", "not_live"]);
  });

  it.each([
    [apiError(403), "forbidden"],
    [apiError(400, "OAPI_MNGR_0109"), "invalid"],
    [apiError(502), "error"],
    [new Error("network"), "error"],
  ])("送れなかった理由を返す（%s）", async (error, reason) => {
    const t = setup([error]);
    expect(await t.sender.send("a")).toEqual({ ok: false, reason });
  });

  it("連携が解除されていたら、解除の処理に渡す", async () => {
    const t = setup([new TokenRevokedError("revoked")]);
    expect(await t.sender.send("a")).toEqual({ ok: false, reason: "unlinked" });
    expect(t.unlinked).toHaveLength(1);
  });

  it("参加していなければ送らない", async () => {
    const t = setup([], { joined: false });
    expect(await t.sender.send("a")).toEqual({ ok: false, reason: "not_joined" });
    expect(t.sent).toEqual([]);
  });

  it("待っている送信が上限を超えたら、古いものから捨てる", async () => {
    const t = setup();
    const results = await Promise.all(["a", "b", "c", "d", "e"].map((m) => t.sender.send(m)));
    // a は送信中のため待ち行列に入らない。b〜e のうち最も古い b を捨てる
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "ok",
      "queue_full",
      "ok",
      "ok",
      "ok",
    ]);
    expect(t.sent).toEqual(["a", "c", "d", "e"]);
  });

  it("退室したら、待っている分を捨てる", async () => {
    const t = setup();
    const first = t.sender.send("a");
    const second = t.sender.send("b");
    t.setJoined(false);
    await t.sender.clear();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: false, reason: "not_joined" });
    expect(t.sent).toEqual(["a"]);

    // 片付けたあとも、参加し直したら送れる
    t.setJoined(true);
    expect(await t.sender.send("c")).toEqual({ ok: true });
  });
});
