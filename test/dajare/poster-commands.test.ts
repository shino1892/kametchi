import { describe, expect, it } from "vitest";
import { DajarePoster } from "../../src/dajare/poster.js";
import { DajareCommands } from "../../src/discord/dajare-commands.js";
import type {
  AutocompleteInteractionLike,
  Choice,
  CommandInteractionLike,
  ReplyOptions,
} from "../../src/discord/interactions.js";
import type { Listener } from "../../src/spoon/events.js";

const chat = (user: Listener, message: string, isDj = false) =>
  ({ kind: "chat", user, message, isDj, at: 0 }) as const;

describe("DajarePoster", () => {
  function setup(options: { recordFails?: boolean; linked?: boolean } = {}) {
    const posted: Array<[string, string]> = [];
    const recorded: string[] = [];
    const deleted: string[] = [];
    const noted: string[] = [];
    const targets = new Set(["target"]);
    const poster = new DajarePoster({
      // テストでは「ダジャレ」を含む文をダジャレ候補とする
      judge: { judge: (text) => text.includes("ダジャレ") },
      targets: {
        isTarget: (id) => targets.has(id),
        noteChatter: (user) => void noted.push(user.id),
      },
      posts: {
        add: async (_connectionId, _channelId, messageId) => {
          if (options.recordFails) throw new Error("db error");
          recorded.push(messageId);
        },
      },
      connectionId: () => (options.linked === false ? null : "conn-1"),
      post: async (nickname, text) => {
        posted.push([nickname, text]);
        return { channelId: "dajare-channel", messageId: `m${posted.length}` };
      },
      deleteMessage: async (_channelId, messageId) => void deleted.push(messageId),
    });
    return { poster, posted, recorded, deleted, noted };
  }

  it("登録した対象のダジャレ候補だけを投稿し、メッセージ ID を記録する", async () => {
    const t = setup();
    expect(
      await t.poster.handleChat(chat({ id: "target", nickname: "しえる" }, " ダジャレだ ")),
    ).toBe(true);
    expect(t.posted).toEqual([["しえる", "ダジャレだ"]]);
    expect(t.recorded).toEqual(["m1"]);
  });

  it("対象でない人・ダジャレでない発言は投稿しない（チャットした人としては覚える）", async () => {
    const t = setup();
    expect(await t.poster.handleChat(chat({ id: "other", nickname: "A" }, "ダジャレだ"))).toBe(
      false,
    );
    expect(await t.poster.handleChat(chat({ id: "target", nickname: "A" }, "こんにちは"))).toBe(
      false,
    );
    expect(t.posted).toEqual([]);
    expect(t.noted).toEqual(["other", "target"]);
  });

  it("推し本人の発言は判定せず、チャットした人の一覧にも入れない", async () => {
    const t = setup();
    expect(
      await t.poster.handleChat(chat({ id: "target", nickname: "推し" }, "ダジャレ", true)),
    ).toBe(false);
    expect(t.noted).toEqual([]);
  });

  it("ニックネームがなければ「リスナー」と表示する", async () => {
    const t = setup();
    await t.poster.handleChat(chat({ id: "target", nickname: null }, "ダジャレ"));
    expect(t.posted[0]?.[0]).toBe("リスナー");
  });

  it("記録できなかった投稿は消す（連携解除のときに消せなくなるため）", async () => {
    const t = setup({ recordFails: true });
    await expect(
      t.poster.handleChat(chat({ id: "target", nickname: "A" }, "ダジャレ")),
    ).rejects.toThrow("db error");
    expect(t.deleted).toEqual(["m1"]);
  });

  it("連携していなければ投稿しない", async () => {
    const t = setup({ linked: false });
    expect(await t.poster.handleChat(chat({ id: "target", nickname: "A" }, "ダジャレ"))).toBe(
      false,
    );
    expect(t.posted).toEqual([]);
  });
});

describe("/dajare-target", () => {
  function setup(options: { linked?: boolean } = {}) {
    const recent: Listener[] = [
      { id: "u1", nickname: "しえる" },
      { id: "u2", nickname: null },
    ];
    const registered = new Map<string, string>();
    const commands = new DajareCommands({
      targets: {
        add: async (userId, memo) => {
          if (!recent.some((l) => l.id === userId)) return false;
          registered.set(userId, memo);
          return true;
        },
        remove: async (userId) => registered.delete(userId),
        list: () => [...registered].map(([userId, memo]) => ({ userId, memo })),
        recentChatters: () => recent,
      },
      isLinked: () => options.linked ?? true,
    });
    return { commands, registered };
  }

  function command(subcommand: string, options: Record<string, string> = {}) {
    const replies: ReplyOptions[] = [];
    const interaction: CommandInteractionLike = {
      userId: "me",
      subcommand: () => subcommand,
      option: (name) => options[name] ?? null,
      reply: async (r) => void replies.push(r),
      deferReply: async () => {},
      editReply: async (r) => void replies.push(r),
    };
    return { interaction, replies };
  }

  function autocomplete(subcommand: string, name: string, value = "") {
    const choices: Choice[][] = [];
    const interaction: AutocompleteInteractionLike = {
      subcommand,
      focused: { name, value },
      respond: async (c) => void choices.push(c),
    };
    return { interaction, choices };
  }

  it("add の候補は、最近チャットした人のニックネーム", async () => {
    const t = setup();
    const a = autocomplete("add", "listener");
    await t.commands.handleAutocomplete(a.interaction);
    expect(a.choices[0]).toEqual([
      { name: "しえる", value: "u1" },
      { name: "（ニックネームなし）", value: "u2" },
    ]);

    const filtered = autocomplete("add", "listener", "しえ");
    await t.commands.handleAutocomplete(filtered.interaction);
    expect(filtered.choices[0]).toEqual([{ name: "しえる", value: "u1" }]);
  });

  it("add で登録し、メモを全員に見える返信で知らせる", async () => {
    const t = setup();
    const c = command("add", { listener: "u1", memo: "しえる" });
    await t.commands.handleCommand(c.interaction);
    expect(t.registered.get("u1")).toBe("しえる");
    expect(c.replies[0]?.content).toContain("「しえる」をダジャレ判定の対象に追加しました");
    expect(c.replies[0]?.ephemeral).toBeUndefined();
  });

  it("候補にない人やメモが空なら登録しない", async () => {
    const t = setup();
    const unknown = command("add", { listener: "guess", memo: "X" });
    await t.commands.handleCommand(unknown.interaction);
    const noMemo = command("add", { listener: "u1", memo: "  " });
    await t.commands.handleCommand(noMemo.interaction);
    expect(t.registered.size).toBe(0);
    expect(unknown.replies[0]?.ephemeral).toBe(true);
  });

  it("remove の候補は登録している対象。外したら知らせる", async () => {
    const t = setup();
    await t.commands.handleCommand(command("add", { listener: "u1", memo: "しえる" }).interaction);
    const a = autocomplete("remove", "target");
    await t.commands.handleAutocomplete(a.interaction);
    expect(a.choices[0]).toEqual([{ name: "しえる", value: "u1" }]);

    const c = command("remove", { target: "u1" });
    await t.commands.handleCommand(c.interaction);
    expect(t.registered.size).toBe(0);
    expect(c.replies[0]?.content).toContain("「しえる」をダジャレ判定の対象から外しました");
  });

  it("list は本人にだけメモの一覧を見せ、user.id は見せない", async () => {
    const t = setup();
    await t.commands.handleCommand(command("add", { listener: "u1", memo: "しえる" }).interaction);
    const c = command("list");
    await t.commands.handleCommand(c.interaction);
    expect(c.replies[0]).toEqual({ ephemeral: true, content: "ダジャレ判定の対象:\n・しえる" });
    expect(c.replies[0]?.content).not.toContain("u1");
  });

  it("連携していなければ使えない", async () => {
    const t = setup({ linked: false });
    const c = command("list");
    await t.commands.handleCommand(c.interaction);
    expect(c.replies[0]?.content).toContain("/link");
  });
});
