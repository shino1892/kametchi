import { describe, expect, it } from "vitest";
import type { SendResult } from "../../src/chat/chat-sender.js";
import { ChatRelay } from "../../src/discord/chat-relay.js";
import { HeartCommands } from "../../src/discord/heart-commands.js";
import type {
  BotReply,
  CommandInteractionLike,
  ReplyOptions,
} from "../../src/discord/interactions.js";

describe("ChatRelay（Discord → 配信のチャット）", () => {
  function setup(options: { joined?: boolean; result?: SendResult } = {}) {
    const sent: string[] = [];
    const relay = new ChatRelay({
      isJoined: () => options.joined ?? true,
      send: async (message) => {
        sent.push(message);
        return options.result ?? { ok: true };
      },
    });
    return { relay, sent };
  }

  it("送れたら ✅ を付ける。前後の空白は除いて送る", async () => {
    const t = setup();
    expect(await t.relay.handle("  こんばんは！  ")).toEqual({ reaction: "✅" });
    expect(t.sent).toEqual(["こんばんは！"]);
  });

  it("参加していなければ送らずに ⚠️ と理由を返す", async () => {
    const t = setup({ joined: false });
    const outcome = await t.relay.handle("こんばんは");
    expect(outcome.reaction).toBe("⚠️");
    expect(outcome.reply).toContain("配信に参加していない");
    expect(t.sent).toEqual([]);
  });

  it("本文がなければ（画像だけの投稿など）送らない", async () => {
    const t = setup();
    expect((await t.relay.handle("   ")).reply).toContain("本文がない");
    expect(t.sent).toEqual([]);
  });

  it("200文字を超えたら送らない（絵文字は2文字として数える）", async () => {
    const t = setup();
    expect((await t.relay.handle("あ".repeat(200))).reaction).toBe("✅");
    const outcome = await t.relay.handle("🍊".repeat(101));
    expect(outcome.reaction).toBe("⚠️");
    expect(outcome.reply).toContain("202文字");
    expect(t.sent).toHaveLength(1);
  });

  it.each([
    ["chat_unavailable", "凍結"],
    ["rate_limited", "送信が多すぎる"],
    ["forbidden", "権限がない"],
    ["not_live", "配信が終わっている"],
  ] as const)("送れなかったら ❌ と理由を返す（%s）", async (reason, message) => {
    const t = setup({ result: { ok: false, reason } });
    const outcome = await t.relay.handle("こんばんは");
    expect(outcome.reaction).toBe("❌");
    expect(outcome.reply).toContain(message);
  });
});

describe("HeartCommands（/heart と配信者のチャットコマンド）", () => {
  function setup(options: { linked?: boolean } = {}) {
    let enabled = true;
    const notifications: BotReply[] = [];
    const commands = new HeartCommands({
      settings: {
        enabled: () => enabled,
        set: async (value) => {
          if (options.linked === false) return false;
          enabled = value;
          return true;
        },
      },
      isLinked: () => options.linked ?? true,
      notify: async (message) => void notifications.push(message),
    });
    return { commands, notifications, enabled: () => enabled };
  }

  function command() {
    const replies: ReplyOptions[] = [];
    const interaction: CommandInteractionLike = {
      userId: "u1",
      reply: async (r) => void replies.push(r),
      deferReply: async () => {},
      editReply: async (r) => void replies.push(r),
    };
    return { interaction, replies };
  }

  it("/heart state:off でオフにし、だれが変えたかを返す", async () => {
    const t = setup();
    const c = command();
    await t.commands.handleCommand(c.interaction, "off");
    expect(t.enabled()).toBe(false);
    expect(c.replies[0]?.content).toBe("💗 <@u1> がハートコメントをオフにしました。");
    expect(c.replies[0]?.ephemeral).toBeUndefined();
  });

  it("/heart だけなら今の設定を本人にだけ表示する", async () => {
    const t = setup();
    const c = command();
    await t.commands.handleCommand(c.interaction, null);
    expect(c.replies[0]).toEqual({ ephemeral: true, content: "ハートコメントは今、オンです。" });
  });

  it("連携していなければ変えない", async () => {
    const t = setup({ linked: false });
    const c = command();
    await t.commands.handleCommand(c.interaction, "off");
    expect(t.enabled()).toBe(true);
    expect(c.replies[0]?.content).toContain("/link");
  });

  it("配信者のチャットコマンドで変えたら、Discord にだけ知らせる", async () => {
    const t = setup();
    await t.commands.handleDjCommand({ type: "heart", enabled: false });
    expect(t.enabled()).toBe(false);
    expect(t.notifications.map((n) => n.content)).toEqual([
      "💗 配信者がチャットでハートコメントをオフにしました。",
    ]);
  });
});
