import { describe, expect, it } from "vitest";
import { type LeaveReason, LiveSession } from "../../src/live/live-session.js";
import type { ListenerActivityEvent } from "../../src/spoon/events.js";
import type { TokenManager } from "../../src/spoon/token-manager.js";
import { setupLinkedMock, until } from "../helpers/live-fixture.js";

const alice = { id: "alice", nickname: "アリス" };

async function setup(options: { heartbeatTimeoutMs?: number; heartbeatMs?: number } = {}) {
  const t = await setupLinkedMock(
    options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {},
  );
  const events: ListenerActivityEvent[] = [];
  const left: LeaveReason[] = [];
  const fatal: unknown[] = [];
  const logs: string[] = [];
  let manager: TokenManager | null = t.manager;
  const session = new LiveSession(
    t.api,
    () => manager,
    {
      onEvent: (event) => void events.push(event),
      onLeft: (reason) => void left.push(reason),
      onFatalError: (error) => void fatal.push(error),
      onLog: (type) => void logs.push(type),
    },
    {
      reconnectBackoffMs: 1,
      maxBackoffMs: 5,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 2_000,
    },
  );
  return {
    ...t,
    session,
    events,
    left,
    fatal,
    logs,
    unlink: () => {
      manager = null;
    },
  };
}

describe("LiveSession 参加・退室", () => {
  it("参加するとイベントストリームに接続し（告知が1回出る）、イベントを受け取る", async () => {
    const t = await setup();
    const liveId = t.mock.startLive("dj-1", "雑談");
    expect(await t.session.join()).toMatchObject({
      kind: "joined",
      live: { liveId, title: "雑談" },
    });
    expect(t.session.isJoined()).toBe(true);
    expect(t.mock.state()).toMatchObject({ streams: 1, noticesPosted: 1 });

    t.mock.chat("dj-1", alice, "こんにちは");
    t.mock.like("dj-1", alice, "FREE");
    await until(() => t.events.length === 2);
    expect(t.events.map((e) => e.kind)).toEqual(["chat", "like"]);
    await t.session.leave();
  });

  it("配信していなければ参加しない", async () => {
    const t = await setup();
    expect(await t.session.join()).toEqual({ kind: "not_live" });
    expect(t.session.isJoined()).toBe(false);
    expect(t.left).toEqual([]);
  });

  it("連携していなければ参加しない", async () => {
    const t = await setup();
    t.unlink();
    t.mock.startLive();
    expect(await t.session.join()).toEqual({ kind: "not_linked" });
  });

  it("参加中にもう一度参加しても、接続し直さない（告知を増やさない）", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    expect(await t.session.join()).toMatchObject({ kind: "already_joined" });
    expect(t.mock.state().noticesPosted).toBe(1);
    await t.session.leave();
  });

  it("退室すると切断し、manual として知らせる", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    expect(await t.session.leave()).toBe(true);
    expect(t.session.isJoined()).toBe(false);
    expect(t.left).toEqual(["manual"]);
    await until(() => t.mock.state().streams === 0);
    expect(await t.session.leave()).toBe(false);
  });

  it("配信者がブロックしていれば参加できない", async () => {
    const t = await setup();
    t.mock.startLive();
    t.mock.setBlocked("dj-1", true);
    expect(await t.session.join()).toEqual({ kind: "failed", reason: "blocked" });
    expect(t.session.isJoined()).toBe(false);
  });

  it("権限が足りなければ参加できない", async () => {
    const t = await setup();
    t.mock.startLive();
    t.mock.failNext("GET", "/v1/live/events", 403);
    expect(await t.session.join()).toEqual({ kind: "failed", reason: "forbidden" });
  });
});

describe("LiveSession 接続の維持", () => {
  it("配信が終わったら（LIVE_ENDED）退室する", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    t.mock.endLive();
    await until(() => !t.session.isJoined());
    expect(t.left).toEqual(["live_ended"]);
  });

  it("TOKEN_EXPIRED ではトークンを更新して、参加したまま接続し直す", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    t.mock.endStreams("dj-1", "TOKEN_EXPIRED");
    await until(() => t.mock.state().noticesPosted === 2 && t.mock.state().streams === 1);
    expect(t.saved).toHaveLength(1);
    expect(t.session.isJoined()).toBe(true);
    expect(t.left).toEqual([]);

    t.mock.like("dj-1", alice, "FREE");
    await until(() => t.events.length === 1);
    await t.session.leave();
  });

  it("RECONNECT ではすぐに接続し直す", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    t.mock.endStreams("dj-1", "RECONNECT");
    await until(() => t.mock.state().noticesPosted === 2 && t.mock.state().streams === 1);
    expect(t.session.isJoined()).toBe(true);
    await t.session.leave();
  });

  it("通信が切れたら、間隔を空けて接続し直す", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    t.mock.dropStreams();
    await until(() => t.mock.state().noticesPosted === 2 && t.mock.state().streams === 1);
    expect(t.logs).toContain("stream_lost");
    expect(t.session.isJoined()).toBe(true);
    await t.session.leave();
  });

  it("ハートビートが途絶えたら、切断とみなして接続し直す", async () => {
    const t = await setup({ heartbeatTimeoutMs: 30, heartbeatMs: 60_000 });
    t.mock.startLive();
    await t.session.join();
    await until(() => t.mock.state().noticesPosted >= 2);
    expect(t.session.isJoined()).toBe(true);
    await t.session.leave();
  });

  it("別の接続ができたら（DUPLICATE_CONNECTION）、接続し直さずに退室する", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    await t.api.connectEvents((await t.connect()).accessToken);
    await until(() => !t.session.isJoined());
    expect(t.left).toEqual(["duplicate_connection"]);
  });

  it("切断中に配信が終わり次の配信が始まっていたら、次の配信には入らずに退室する", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    // LIVE_ENDED を受け取れないまま配信が入れ替わった状況
    t.mock.failNext("GET", "/v1/live", 502);
    t.mock.dropStreams();
    t.mock.endLive();
    t.mock.startLive();
    await until(() => !t.session.isJoined());
    expect(t.left).toEqual(["live_ended"]);
    expect(t.mock.state().noticesPosted).toBe(1);
  });

  it("連携が解除されていたら、解除の処理に渡して退室する", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    t.mock.revokeDj("dj-1");
    t.mock.endStreams("dj-1", "TOKEN_EXPIRED");
    await until(() => !t.session.isJoined());
    expect(t.fatal).toHaveLength(1);
    expect(t.left).toEqual(["unlinked"]);
  });

  it("reconnectNow で接続だけを切り直す（参加したまま）", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();
    t.session.reconnectNow();
    await until(() => t.mock.state().noticesPosted === 2 && t.mock.state().streams === 1);
    expect(t.session.isJoined()).toBe(true);
    expect(t.left).toEqual([]);
    await t.session.leave();
  });

  it("同じイベント ID は2回処理しない", async () => {
    const t = await setup();
    const like = JSON.stringify({
      user: alice,
      type: "FREE",
      totalAmount: 1,
      time: "2026-10-15T00:00:00Z",
    });
    const items = [
      { type: "event" as const, event: "like", data: like, id: "1-0" },
      { type: "event" as const, event: "like", data: like, id: "1-0" },
      { type: "event" as const, event: "like", data: like, id: "1-1" },
      {
        type: "event" as const,
        event: "end",
        data: JSON.stringify({ reason: "LIVE_ENDED" }),
        id: "1-2",
      },
    ];
    const events: ListenerActivityEvent[] = [];
    const session = new LiveSession(
      {
        getLive: async () => ({ liveId: 1, title: "", startedAt: 0 }),
        connectEvents: async () =>
          (async function* () {
            yield* items;
          })(),
      },
      () => t.manager,
      { onEvent: (event) => void events.push(event) },
    );
    await session.join();
    await until(() => !session.isJoined());
    await until(() => events.length >= 2);
    expect(events).toHaveLength(2);
  });
});
