import type { DajareTargets } from "../dajare/targets.js";
import type {
  AutocompleteInteractionLike,
  Choice,
  CommandInteractionLike,
} from "./interactions.js";

/** Discord の選択肢の上限 */
const MAX_CHOICES = 25;
/** 選択肢の名前の上限（Discord の制限） */
const MAX_CHOICE_NAME = 100;

export interface DajareCommandsDeps {
  targets: Pick<DajareTargets, "add" | "remove" | "list" | "recentChatters">;
  isLinked(): boolean;
}

/**
 * /dajare-target（仕様書 §8.1）。公式 API の user.id は暗号化された値のため、
 * 参加中の配信で最近チャットした人の中から選んで登録する。
 *
 *   /dajare-target add listener:<選ぶ> memo:<一覧に出す名前>
 *   /dajare-target remove target:<選ぶ>
 *   /dajare-target list
 */
export class DajareCommands {
  constructor(private readonly deps: DajareCommandsDeps) {}

  async handleCommand(interaction: CommandInteractionLike): Promise<void> {
    if (!this.deps.isLinked()) {
      await interaction.reply({
        ephemeral: true,
        content: "Spoon と連携していません。/link で配信者に連携してもらってください。",
      });
      return;
    }
    const option = (name: string) => interaction.option?.(name)?.trim() ?? "";

    switch (interaction.subcommand?.()) {
      case "add": {
        const memo = option("memo");
        const added = memo !== "" && (await this.deps.targets.add(option("listener"), memo));
        await interaction.reply(
          added
            ? {
                content: `🎯 「${memo}」をダジャレ判定の対象に追加しました（本人の了承を得た人だけを登録してください）。`,
              }
            : {
                ephemeral: true,
                content:
                  "候補の中から選んでください。選べるのは、参加中の配信で最近チャットした人だけです（ボットが配信に参加していないと、候補は出ません）。",
              },
        );
        return;
      }
      case "remove": {
        const userId = option("target");
        const memo = this.deps.targets.list().find((t) => t.userId === userId)?.memo;
        const removed = await this.deps.targets.remove(userId);
        await interaction.reply(
          removed
            ? { content: `🎯 「${memo}」をダジャレ判定の対象から外しました。` }
            : { ephemeral: true, content: "登録している対象の中から選んでください。" },
        );
        return;
      }
      case "list": {
        const targets = this.deps.targets.list();
        await interaction.reply({
          ephemeral: true,
          content:
            targets.length === 0
              ? "ダジャレ判定の対象は登録していません。"
              : ["ダジャレ判定の対象:", ...targets.map((t) => `・${t.memo}`)].join("\n"),
        });
        return;
      }
      default:
        await interaction.reply({
          ephemeral: true,
          content: "使い方: /dajare-target add・remove・list",
        });
    }
  }

  /** 入力中の候補。add では最近チャットした人、remove では登録している対象 */
  async handleAutocomplete(interaction: AutocompleteInteractionLike): Promise<void> {
    const query = interaction.focused.value.trim().toLowerCase();
    let choices: Choice[] = [];
    if (interaction.subcommand === "add" && interaction.focused.name === "listener") {
      choices = this.deps.targets.recentChatters().map((listener) => ({
        name: listener.nickname?.trim() || "（ニックネームなし）",
        value: listener.id,
      }));
    } else if (interaction.subcommand === "remove" && interaction.focused.name === "target") {
      choices = this.deps.targets
        .list()
        .map((target) => ({ name: target.memo, value: target.userId }));
    }
    await interaction.respond(
      choices
        .filter((choice) => query === "" || choice.name.toLowerCase().includes(query))
        .slice(0, MAX_CHOICES)
        .map((choice) => ({
          ...choice,
          name: [...choice.name].slice(0, MAX_CHOICE_NAME).join(""),
        })),
    );
  }
}
