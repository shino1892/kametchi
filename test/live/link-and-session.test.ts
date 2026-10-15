import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LeaveReason, LiveSession } from "../../src/live/live-session.js";
import { setupLink } from "../helpers/link-fixture.js";
import { until } from "../helpers/live-fixture.js";

/** app.ts と同じつなぎ方で、連携の解除と参加中の接続を組み合わせる */
async function setup() {
  const t = await setupLink();
  const left: LeaveReason[] = [];
  const session = new LiveSession(
    t.spoon.api,
    () => t.link.tokens(),
    {
      onLeft: (reason) => void left.push(reason),
      onFatalError: (error) => t.link.handleError(error).then(() => {}),
    },
    { reconnectBackoffMs: 1, maxBackoffMs: 5 },
  );
  t.link.addListener({
    onLinked: () => {
      if (session.isJoined()) session.reconnectNow();
    },
    onUnlinking: async () => {
      await session.leave("unlinked");
    },
  });
  return { ...t, session, left };
}

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.close());

describe("連携と参加の組み合わせ", () => {
  it("参加中に /unlink で解除すると、退室してから削除する", async () => {
    await t.linkThrough();
    t.spoon.mock.startLive();
    expect(await t.session.join()).toMatchObject({ kind: "joined" });

    await t.link.unlink("manual");
    expect(t.session.isJoined()).toBe(false);
    expect(t.left).toEqual(["unlinked"]);
    await until(() => t.spoon.mock.state().streams === 0);
    expect(await t.connections.get()).toBeNull();
  });

  it("参加中に Spoon 側で連携が解除されたら、止まらずに退室してデータを削除する", async () => {
    await t.linkThrough();
    t.spoon.mock.startLive();
    await t.session.join();

    t.spoon.mock.revokeDj("dj-1");
    t.spoon.mock.endStreams("dj-1", "TOKEN_EXPIRED");
    await until(
      () => !t.session.isJoined() && t.notifications.some((n) => n.includes("Spoon 側で")),
    );
    expect(await t.connections.get()).toBeNull();
    expect(t.link.isLinked()).toBe(false);
  });

  it("参加中に連携し直すと、参加したまま新しいトークンで接続し直す", async () => {
    await t.linkThrough();
    t.spoon.mock.startLive();
    await t.session.join();

    await t.linkThrough();
    await until(
      () => t.spoon.mock.state().noticesPosted === 2 && t.spoon.mock.state().streams === 1,
    );
    expect(t.session.isJoined()).toBe(true);
    expect(t.left).toEqual([]);
    await t.session.leave();
  });
});
