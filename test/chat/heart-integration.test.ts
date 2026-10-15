import { describe, expect, it } from "vitest";
import { ChatSender } from "../../src/chat/chat-sender.js";
import { parseDjCommand } from "../../src/chat/dj-commands.js";
import { HEART_COMMENT, HeartCommenter } from "../../src/chat/heart-comment.js";
import { ChatRelay } from "../../src/discord/chat-relay.js";
import { LiveSession } from "../../src/live/live-session.js";
import { setupLinkedMock, until } from "../helpers/live-fixture.js";

const alice = { id: "alice", nickname: "アリス" };
const dj = { id: "dj", nickname: "推し" };

/** app.ts と同じつなぎ方（送信の間隔だけ短くする） */
async function setup() {
  const t = await setupLinkedMock();
  let heartOn = true;
  const sender: ChatSender = new ChatSender(
    {
      send: (message, signal) =>
        t.manager.withAccessToken((token) => t.api.sendChat(token, message, signal)),
      canSend: () => session.isJoined(),
    },
    { minIntervalMs: 30 },
  );
  const commenter = new HeartCommenter({
    enabled: () => heartOn,
    send: (message) => sender.send(message),
  });
  const session = new LiveSession(t.api, () => t.manager, {
    onEvent: (event) => {
      if (event.kind === "like") commenter.handle(event);
      if (event.kind === "chat" && event.isDj) {
        const command = parseDjCommand(event.message);
        if (command) heartOn = command.enabled;
      }
    },
    onLeft: () => sender.clear(),
  });
  const relay = new ChatRelay({
    isJoined: () => session.isJoined(),
    send: (message) => sender.send(message),
  });
  return { ...t, session, sender, relay, heartOn: () => heartOn };
}

describe("ハートコメント（モックの配信で通して確認）", () => {
  it("ハートが続けて届いても、ハートコメントは連投にならない", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();

    for (let i = 0; i < 10; i++) t.mock.like("dj-1", { id: `l${i % 3}`, nickname: null }, "FREE");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.sender.idle();
    const sent = t.mock.sentChats();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(new Set(sent)).toEqual(new Set([HEART_COMMENT]));
    await t.session.leave();
  });

  it("有料ハート1個には送り、バスターなど2個以上には送らない", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();

    t.mock.like("dj-1", alice, "PAID", 10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.mock.sentChats()).toEqual([]);

    t.mock.like("dj-1", alice, "PAID", 1);
    await until(() => t.mock.sentChats().length === 1);
    await t.session.leave();
  });

  it("推しが「!ハート off」と送ったら送らない。リスナーが送っても変わらない", async () => {
    const t = await setup();
    t.mock.startLive();
    await t.session.join();

    t.mock.chat("dj-1", alice, "!ハート off");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.heartOn()).toBe(true);

    t.mock.chat("dj-1", dj, "!ハート off", true);
    await until(() => !t.heartOn());
    t.mock.like("dj-1", alice, "FREE");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.mock.sentChats()).toEqual([]);
    await t.session.leave();
  });

  it("Discord からのコメントをボットの名前で送り、参加していなければ送らない", async () => {
    const t = await setup();
    t.mock.startLive();
    expect((await t.relay.handle("こんばんは")).reaction).toBe("⚠️");

    await t.session.join();
    expect(await t.relay.handle("こんばんは")).toEqual({ reaction: "✅" });
    expect(t.mock.sentChats()).toEqual(["こんばんは"]);

    t.mock.setChatFrozen("dj-1", true);
    expect((await t.relay.handle("もしもし")).reaction).toBe("❌");
    await t.session.leave();
    expect((await t.relay.handle("おやすみ")).reaction).toBe("⚠️");
  });
});
