import { describe, expect, it } from "vitest";
import type {
  BotReply,
  ButtonInteractionLike,
  ReplyOptions,
} from "../../src/discord/interactions.js";
import { LinkCommands, UNLINK_CONFIRM_TTL_MS } from "../../src/discord/link-commands.js";
import type { UnlinkResult } from "../../src/link/spoon-link.js";
import { FakeClock } from "../helpers/fake-clock.js";

function setup(options: { linked?: boolean } = {}) {
  const clock = new FakeClock(0);
  const unlinkCalls: string[] = [];
  const notifications: string[] = [];
  const commands = new LinkCommands({
    link: {
      isLinked: () => options.linked ?? true,
      createInvite: async () => ({
        url: "https://kametchi.com/link/abc",
        expiresAt: new Date(600_000),
      }),
      unlinkPreview: async () => (options.linked === false ? null : { targets: 1, posts: 3 }),
      unlink: async (reason): Promise<UnlinkResult> => {
        unlinkCalls.push(reason);
        return { reason, deletedPosts: 3, failedPosts: 0 };
      },
    },
    notify: async (message) => {
      notifications.push(message);
    },
    clock,
  });
  return { clock, commands, unlinkCalls, notifications };
}

function command(userId = "user-1") {
  const replies: ReplyOptions[] = [];
  return {
    userId,
    replies,
    reply: async (r: ReplyOptions) => void replies.push(r),
    deferReply: async () => {},
    editReply: async (r: BotReply) => void replies.push(r),
  };
}

function button(customId: string, userId = "user-1") {
  const updates: BotReply[] = [];
  const replies: ReplyOptions[] = [];
  const steps: string[] = [];
  const interaction: ButtonInteractionLike = {
    userId,
    customId,
    update: async (r) => {
      steps.push("update");
      updates.push(r);
    },
    reply: async (r) => {
      replies.push(r);
    },
    deferUpdate: async () => {
      steps.push("defer");
    },
    deferReply: async () => {
      steps.push("deferReply");
    },
    editReply: async (r) => {
      steps.push("edit");
      updates.push(r);
    },
  };
  return { interaction, updates, replies, steps };
}

/** /unlink の確認メッセージから、ボタンの customId を取り出す */
async function startUnlink(t: ReturnType<typeof setup>, userId = "user-1") {
  const i = command(userId);
  await t.commands.handleUnlink(i);
  const reply = i.replies[0];
  const [confirm, cancel] = reply?.buttons ?? [];
  return { reply, confirmId: confirm?.customId ?? "", cancelId: cancel?.customId ?? "" };
}

describe("/link", () => {
  it("招待の URL を本人にだけ見える返信で返し、発行したことをメインチャンネルに知らせる", async () => {
    const t = setup({ linked: false });
    const i = command();
    await t.commands.handleLink(i);
    expect(i.replies[0]?.ephemeral).toBe(true);
    expect(i.replies[0]?.content).toContain("https://kametchi.com/link/abc");
    expect(i.replies[0]?.content).not.toContain("すでに連携しています");
    expect(t.notifications[0]).toContain("<@user-1>");
    expect(t.notifications[0]).not.toContain("https://kametchi.com/link/abc");
  });

  it("連携済みなら、連携し直しになることを書き添える", async () => {
    const t = setup();
    const i = command();
    await t.commands.handleLink(i);
    expect(i.replies[0]?.content).toContain("すでに連携しています");
  });
});

describe("/unlink", () => {
  it("すぐには解除せず、本人にだけ見える確認メッセージに「解除する」「キャンセル」を出す", async () => {
    const t = setup();
    const { reply, confirmId, cancelId } = await startUnlink(t);
    expect(t.unlinkCalls).toEqual([]);
    expect(reply?.ephemeral).toBe(true);
    expect(reply?.content).toContain("元には戻せません");
    expect(reply?.content).toContain("ダジャレ判定の対象（1人）");
    expect(reply?.content).toContain("Discord に投稿したダジャレ（3件");
    expect(reply?.buttons?.map((b) => [b.label, b.style])).toEqual([
      ["解除する", "danger"],
      ["キャンセル", "secondary"],
    ]);
    expect(confirmId).not.toBe(cancelId);
  });

  it("「解除する」を押したら、先に応答してから解除し、ボタンを消して結果を表示する", async () => {
    const t = setup();
    const { confirmId } = await startUnlink(t);
    const b = button(confirmId);
    expect(await t.commands.handleButton(b.interaction)).toBe(true);
    expect(t.unlinkCalls).toEqual(["manual"]);
    expect(b.steps).toEqual(["defer", "edit"]);
    expect(b.updates[0]).toEqual({
      content: "Spoon 連携を解除しました（削除したダジャレの投稿: 3件）。",
      buttons: [],
    });
  });

  it("「キャンセル」を押したら解除しない", async () => {
    const t = setup();
    const { confirmId, cancelId } = await startUnlink(t);
    const b = button(cancelId);
    await t.commands.handleButton(b.interaction);
    expect(t.unlinkCalls).toEqual([]);
    expect(b.updates[0]?.content).toContain("キャンセルしました");
    expect(b.updates[0]?.buttons).toEqual([]);

    // キャンセルしたあとに「解除する」を押しても解除しない
    await t.commands.handleButton(button(confirmId).interaction);
    expect(t.unlinkCalls).toEqual([]);
  });

  it("60秒を過ぎた確認では解除しない", async () => {
    const t = setup();
    const { confirmId } = await startUnlink(t);
    t.clock.advance(UNLINK_CONFIRM_TTL_MS);
    const b = button(confirmId);
    await t.commands.handleButton(b.interaction);
    expect(t.unlinkCalls).toEqual([]);
    expect(b.updates[0]?.content).toContain("この確認は無効です");
  });

  it("同じ確認で2回解除しない", async () => {
    const t = setup();
    const { confirmId } = await startUnlink(t);
    await t.commands.handleButton(button(confirmId).interaction);
    const second = button(confirmId);
    await t.commands.handleButton(second.interaction);
    expect(t.unlinkCalls).toEqual(["manual"]);
    expect(second.updates[0]?.content).toContain("この確認は無効です");
  });

  it("/unlink を実行した人以外は「解除する」を使えない", async () => {
    const t = setup();
    const { confirmId } = await startUnlink(t, "user-1");
    const b = button(confirmId, "user-2");
    await t.commands.handleButton(b.interaction);
    expect(t.unlinkCalls).toEqual([]);
    expect(b.replies[0]?.content).toContain("実行した人だけ");

    // 本人なら、そのあとでも解除できる
    await t.commands.handleButton(button(confirmId, "user-1").interaction);
    expect(t.unlinkCalls).toEqual(["manual"]);
  });

  it("連携していなければ、確認を出さずにその旨を返す", async () => {
    const t = setup({ linked: false });
    const i = command();
    await t.commands.handleUnlink(i);
    expect(i.replies[0]?.content).toBe("Spoon と連携していません。");
    expect(i.replies[0]?.buttons).toBeUndefined();
  });

  it("ほかの機能のボタンは処理しない", async () => {
    const t = setup();
    expect(await t.commands.handleButton(button("join:10001").interaction)).toBe(false);
  });
});
