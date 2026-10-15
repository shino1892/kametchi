import type { DjCommand } from "../chat/dj-commands.js";
import type { HeartSettings } from "../chat/heart-settings.js";
import type { BotReply, CommandInteractionLike } from "./interactions.js";

export interface HeartCommandsDeps {
  settings: Pick<HeartSettings, "enabled" | "set">;
  isLinked(): boolean;
  /** Discord のメインチャンネルへの通知 */
  notify(message: BotReply): Promise<void>;
}

const onOff = (enabled: boolean) => (enabled ? "オン" : "オフ");

/**
 * ハートコメントのオン・オフ（仕様書 §7.4）。Discord の /heart と、推しのチャットコマンド。
 * 推しのチャットコマンドの結果は Discord にだけ知らせ、配信のチャットには投稿しない。
 */
export class HeartCommands {
  constructor(private readonly deps: HeartCommandsDeps) {}

  /** /heart（state を省略したら現在の設定を表示する） */
  async handleCommand(
    interaction: CommandInteractionLike,
    state: "on" | "off" | null,
  ): Promise<void> {
    if (!this.deps.isLinked()) {
      await interaction.reply({
        ephemeral: true,
        content: "Spoon と連携していません。/link で推しに連携してもらってください。",
      });
      return;
    }
    if (state === null) {
      await interaction.reply({
        ephemeral: true,
        content: `ハートコメントは今、${onOff(this.deps.settings.enabled())}です。`,
      });
      return;
    }
    const enabled = state === "on";
    await this.deps.settings.set(enabled);
    await interaction.reply({
      content: `💗 <@${interaction.userId}> がハートコメントを${onOff(enabled)}にしました。`,
    });
  }

  /** 推しのチャットコマンド */
  async handleDjCommand(command: DjCommand): Promise<void> {
    if (!(await this.deps.settings.set(command.enabled))) return;
    await this.deps.notify({
      content: `💗 推しが配信のチャットでハートコメントを${onOff(command.enabled)}にしました。`,
    });
  }
}
