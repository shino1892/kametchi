import { describe, expect, it } from "vitest";
import type {
  BotReply,
  ButtonInteractionLike,
  CommandInteractionLike,
  ReplyOptions,
} from "../../src/discord/interactions.js";
import { LiveCommands } from "../../src/discord/live-commands.js";
import type { JoinResult, LeaveReason } from "../../src/live/live-session.js";
import type { LiveInfo } from "../../src/spoon/api.js";

const live: LiveInfo = { liveId: 10001, title: "夜の雑談", startedAt: 0 };

function setup(
  options: { linked?: boolean; joinResult?: JoinResult; watching?: LiveInfo | null } = {},
) {
  let joined = false;
  const calls: string[] = [];
  const notifications: BotReply[] = [];
  const commands = new LiveCommands({
    session: {
      join: async () => {
        calls.push("join");
        const result = options.joinResult ?? { kind: "joined", live };
        if (result.kind === "joined") joined = true;
        return result;
      },
      leave: async (reason?: LeaveReason) => {
        calls.push(`leave ${reason}`);
        const was = joined;
        joined = false;
        return was;
      },
      isJoined: () => joined,
      current: () => (joined ? live : null),
    },
    watcher: { current: () => (options.watching === undefined ? live : options.watching) },
    isLinked: () => options.linked ?? true,
    notify: async (message) => void notifications.push(message),
  });
  return { commands, calls, notifications, setJoined: (value: boolean) => (joined = value) };
}

function command() {
  const replies: ReplyOptions[] = [];
  const steps: string[] = [];
  const interaction: CommandInteractionLike = {
    userId: "u1",
    reply: async (r) => {
      steps.push("reply");
      replies.push(r);
    },
    deferReply: async () => void steps.push("defer"),
    editReply: async (r) => {
      steps.push("edit");
      replies.push(r);
    },
  };
  return { interaction, replies, steps };
}

function button(customId: string) {
  const replies: ReplyOptions[] = [];
  const steps: string[] = [];
  const interaction: ButtonInteractionLike = {
    userId: "u1",
    customId,
    update: async (r) => {
      steps.push("update");
      replies.push(r);
    },
    reply: async (r) => {
      steps.push("reply");
      replies.push(r);
    },
    deferUpdate: async () => void steps.push("deferUpdate"),
    deferReply: async () => void steps.push("deferReply"),
    editReply: async (r) => {
      steps.push("edit");
      replies.push(r);
    },
  };
  return { interaction, replies, steps };
}

describe("配信の通知", () => {
  it("配信が始まったら、タイトルと「配信に参加」ボタンを付けて知らせる", async () => {
    const t = setup();
    await t.commands.onLiveStarted(live);
    expect(t.notifications[0]?.content).toContain("推しの配信が始まりました");
    expect(t.notifications[0]?.content).toContain("夜の雑談");
    expect(t.notifications[0]?.buttons).toEqual([
      { customId: "live:join:10001", label: "配信に参加", style: "primary", emoji: "🎧" },
    ]);
  });

  it("配信の終了は、検知と退室の両方から届いても1回だけ知らせる", async () => {
    const t = setup();
    await t.commands.onLeft("live_ended", live);
    await t.commands.onLiveEnded(live);
    expect(t.notifications.map((n) => n.content)).toEqual([
      "📴 推しの配信が終了しました。ボットも退室しました。",
    ]);
  });

  it("重複接続・ブロック・権限不足で退室したら理由を知らせる。手動の退室では知らせない", async () => {
    const t = setup();
    await t.commands.onLeft("manual", live);
    await t.commands.onLeft("unlinked", live);
    expect(t.notifications).toEqual([]);
    await t.commands.onLeft("duplicate_connection", live);
    await t.commands.onLeft("blocked", live);
    await t.commands.onLeft("forbidden", live);
    expect(t.notifications.map((n) => n.content)).toEqual([
      expect.stringContaining("重複して起動していないか"),
      expect.stringContaining("ブロック"),
      expect.stringContaining("/link で連携し直して"),
    ]);
  });
});

describe("/join と「配信に参加」ボタン", () => {
  it("/join は先に応答してから参加し、「退室」ボタン付きで結果を返す", async () => {
    const t = setup();
    const c = command();
    await t.commands.handleJoinCommand(c.interaction);
    expect(c.steps).toEqual(["defer", "edit"]);
    expect(c.replies[0]?.content).toContain("推しの配信に参加しました");
    expect(c.replies[0]?.buttons?.[0]).toMatchObject({ customId: "live:leave", label: "退室" });
  });

  it("参加中なら、参加し直さずに本人にだけ伝える", async () => {
    const t = setup();
    t.setJoined(true);
    const c = command();
    await t.commands.handleJoinCommand(c.interaction);
    expect(t.calls).toEqual([]);
    expect(c.replies[0]).toMatchObject({
      ephemeral: true,
      content: "すでに配信に参加しています。",
    });
  });

  it("連携していなければ参加しない", async () => {
    const t = setup({ linked: false });
    const c = command();
    await t.commands.handleJoinCommand(c.interaction);
    expect(t.calls).toEqual([]);
    expect(c.replies[0]?.content).toContain("/link");
  });

  it.each([
    [{ kind: "not_live" } as const, "推しは今、配信していません。"],
    [
      { kind: "failed", reason: "blocked" } as const,
      "ブロックしているため、ボットは参加できませんでした",
    ],
    [{ kind: "failed", reason: "forbidden" } as const, "参加できませんでした"],
  ])("参加できなかったときは理由を返す（%o）", async (joinResult, message) => {
    const t = setup({ joinResult });
    const c = command();
    await t.commands.handleJoinCommand(c.interaction);
    expect(c.replies[0]?.content).toContain(message);
    expect(c.replies[0]?.buttons).toBeUndefined();
  });

  it("通知の「配信に参加」ボタンで参加する（通知のメッセージはそのまま残す）", async () => {
    const t = setup();
    const b = button("live:join:10001");
    expect(await t.commands.handleButton(b.interaction)).toBe(true);
    expect(t.calls).toEqual(["join"]);
    expect(b.steps).toEqual(["deferReply", "edit"]);
  });

  it("終わった配信の通知のボタンでは参加しない", async () => {
    const t = setup({ watching: { liveId: 10002, title: "", startedAt: 0 } });
    const b = button("live:join:10001");
    await t.commands.handleButton(b.interaction);
    expect(t.calls).toEqual([]);
    expect(b.replies[0]).toMatchObject({ ephemeral: true });
    expect(b.replies[0]?.content).toContain("この配信は終了しています");
  });
});

describe("/leave と「退室」ボタン", () => {
  it("/leave で退室する", async () => {
    const t = setup();
    t.setJoined(true);
    const c = command();
    await t.commands.handleLeaveCommand(c.interaction);
    expect(t.calls).toEqual(["leave manual"]);
    expect(c.replies[0]?.content).toBe("👋 配信から退室しました。");
  });

  it("参加していなければ、本人にだけ伝える", async () => {
    const t = setup();
    const c = command();
    await t.commands.handleLeaveCommand(c.interaction);
    expect(t.calls).toEqual([]);
    expect(c.replies[0]).toMatchObject({ ephemeral: true, content: "配信に参加していません。" });
  });

  it("「退室」ボタンで退室し、ボタンを消す", async () => {
    const t = setup();
    t.setJoined(true);
    const b = button("live:leave");
    await t.commands.handleButton(b.interaction);
    expect(t.calls).toEqual(["leave manual"]);
    expect(b.steps).toEqual(["deferUpdate", "edit"]);
    expect(b.replies[0]).toEqual({ content: "👋 配信から退室しました。", buttons: [] });
  });

  it("すでに退室していれば、そう書いてボタンを消す", async () => {
    const t = setup();
    const b = button("live:leave");
    await t.commands.handleButton(b.interaction);
    expect(b.replies[0]?.content).toContain("すでに退室しています");
    expect(b.replies[0]?.buttons).toEqual([]);
  });

  it("ほかの機能のボタンは処理しない", async () => {
    const t = setup();
    expect(await t.commands.handleButton(button("unlink:confirm:x").interaction)).toBe(false);
  });
});
