import { describe, expect, it } from "vitest";
import { LiveWatcher } from "../../src/live/live-watcher.js";
import type { LiveInfo } from "../../src/spoon/api.js";
import { TokenRevokedError } from "../../src/spoon/errors.js";
import { setupLinkedMock } from "../helpers/live-fixture.js";

async function setup(options: { linked?: boolean } = {}) {
  const t = await setupLinkedMock();
  const events: string[] = [];
  const logs: string[] = [];
  const fatal: unknown[] = [];
  const watcher = new LiveWatcher(t.api, () => (options.linked === false ? null : t.manager), {
    onLiveStarted: (live: LiveInfo) => void events.push(`started ${live.liveId} ${live.title}`),
    onLiveEnded: (live: LiveInfo) => void events.push(`ended ${live.liveId}`),
    onFatalError: (error) => {
      if (!(error instanceof TokenRevokedError)) return false;
      fatal.push(error);
      return true;
    },
    onLog: (type) => void logs.push(type),
  });
  return { ...t, watcher, events, logs, fatal };
}

describe("LiveWatcher", () => {
  it("配信が始まったら1回だけ知らせ、終わったら知らせる", async () => {
    const t = await setup();
    expect(await t.watcher.check()).toBeNull();

    const liveId = t.mock.startLive("dj-1", "夜の雑談");
    expect(await t.watcher.check()).toMatchObject({ liveId, title: "夜の雑談" });
    await t.watcher.check();
    expect(t.events).toEqual([`started ${liveId} 夜の雑談`]);

    t.mock.endLive();
    expect(await t.watcher.check()).toBeNull();
    await t.watcher.check();
    expect(t.events).toEqual([`started ${liveId} 夜の雑談`, `ended ${liveId}`]);
  });

  it("確認しただけではイベントストリームに接続しない（ボットは入室しない）", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.watcher.check();
    expect(t.mock.state().streams).toBe(0);
    expect(t.mock.state().noticesPosted).toBe(0);
  });

  it("確認の合間に次の配信が始まっていたら、前の配信を終わらせてから新しい配信を知らせる", async () => {
    const t = await setup();
    const first = t.mock.startLive();
    await t.watcher.check();
    t.mock.endLive();
    const second = t.mock.startLive();
    await t.watcher.check();
    expect(t.events).toEqual([
      `started ${first} テスト配信`,
      `ended ${first}`,
      `started ${second} テスト配信`,
    ]);
  });

  it("一時的なエラーでは配信の状態を変えず、記録は状態が変わったときだけ残す", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.watcher.check();
    for (let i = 0; i < 3; i++) {
      t.mock.failNext("GET", "/v1/live", 403);
      await t.watcher.check();
    }
    expect(t.watcher.current()).not.toBeNull();
    expect(t.logs.filter((type) => type === "watch_failed")).toHaveLength(1);
  });

  it("連携が解除されていたら（invalid_grant）、続けられないエラーとして渡す", async () => {
    const t = await setup();
    t.mock.revokeDj("dj-1");
    await expect(t.watcher.check()).rejects.toBeInstanceOf(TokenRevokedError);
    expect(t.fatal).toHaveLength(1);
  });

  it("連携していなければ何もしない", async () => {
    const t = await setup({ linked: false });
    t.mock.startLive();
    expect(await t.watcher.check()).toBeNull();
    expect(t.events).toEqual([]);
  });

  it("通知に失敗しても、配信の状態は変える", async () => {
    const t = await setupLinkedMock();
    const watcher = new LiveWatcher(t.api, () => t.manager, {
      onLiveStarted: () => {
        throw new Error("discord down");
      },
      onLiveEnded: () => {},
      onFatalError: () => false,
    });
    t.mock.startLive();
    expect(await watcher.check()).not.toBeNull();
  });

  it("start で定期確認を始め、stop で止めて配信を忘れる", async () => {
    const t = await setupLinkedMock();
    const events: string[] = [];
    const watcher = new LiveWatcher(
      t.api,
      () => t.manager,
      {
        onLiveStarted: () => void events.push("started"),
        onLiveEnded: () => void events.push("ended"),
        onFatalError: () => false,
      },
      { intervalMs: 5 },
    );
    t.mock.startLive();
    watcher.start();
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await watcher.stop();
    expect(events).toEqual(["started"]);
    expect(watcher.current()).toBeNull();
  });
});

describe("LiveWatcher の記録", () => {
  it("確認を始めたことと、配信していないことを、状態が変わったときだけ記録する", async () => {
    const t = await setup();
    await t.watcher.check();
    await t.watcher.check();
    t.mock.startLive();
    await t.watcher.check();
    t.mock.endLive();
    await t.watcher.check();
    await t.watcher.check();
    expect(t.logs).toEqual(["not_live", "live_detected", "live_ended", "not_live"]);
  });
});
