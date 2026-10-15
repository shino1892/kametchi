import { randomBytes } from "node:crypto";
import type { SpoonLink } from "../link/spoon-link.js";
import { type Clock, systemClock } from "../spoon/clock.js";
import type { BotReply, ButtonInteractionLike, CommandInteractionLike } from "./interactions.js";

/** /unlink の確認を受け付ける時間 */
export const UNLINK_CONFIRM_TTL_MS = 60_000;

const CONFIRM_PREFIX = "unlink:confirm:";
const CANCEL_PREFIX = "unlink:cancel:";

export interface LinkCommandsDeps {
  link: Pick<SpoonLink, "createInvite" | "isLinked" | "unlinkPreview" | "unlink">;
  /** Discord のメインチャンネルへの通知 */
  notify(message: string): Promise<void>;
  clock?: Clock;
}

/**
 * Discord の /link と /unlink（仕様書 §5）。
 *
 * /unlink はすぐには解除せず、実行した本人にだけ見える確認メッセージを出し、
 * 「解除する」が押されたときだけ解除する（誤操作で解除しないように）。確認は60秒で無効になる。
 */
export class LinkCommands {
  private readonly pending = new Map<string, { userId: string; expiresAt: number }>();
  private readonly clock: Clock;

  constructor(private readonly deps: LinkCommandsDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async handleLink(interaction: CommandInteractionLike): Promise<void> {
    const relink = this.deps.link.isLinked();
    const { url } = await this.deps.link.createInvite();
    await interaction.reply({
      ephemeral: true,
      content: [
        ...(relink
          ? ["すでに連携しています。この URL で連携し直すと、新しい連携に置き換わります。", ""]
          : []),
        "推しに、次の URL を開いてもらってください（10分間・1回だけ使えます）。",
        url,
        "",
        "・推し本人（DJ）の Spoon アカウントで同意してもらってください。",
        "・ボットのアカウントで Spoon Developers にログインしているブラウザでは、シークレットウィンドウで開いてください。",
        "・この URL はほかの人に見せないでください。",
      ].join("\n"),
    });
    await this.deps.notify(
      `🔗 <@${interaction.userId}> が Spoon 連携用の URL を発行しました（10分間・1回だけ有効）。`,
    );
  }

  async handleUnlink(interaction: CommandInteractionLike): Promise<void> {
    const preview = await this.deps.link.unlinkPreview();
    if (!preview) {
      await interaction.reply({ ephemeral: true, content: "Spoon と連携していません。" });
      return;
    }

    this.prune();
    const nonce = randomBytes(12).toString("base64url");
    this.pending.set(nonce, {
      userId: interaction.userId,
      expiresAt: this.clock.now() + UNLINK_CONFIRM_TTL_MS,
    });
    await interaction.reply({
      ephemeral: true,
      content: [
        "⚠️ **Spoon 連携を解除しますか？**",
        "解除すると、ボットは配信から退室し、Spoon のトークンを無効にして、次のデータを削除します。**元には戻せません。**",
        "・ハートコメントのオン・オフの設定",
        `・ダジャレ判定の対象（${preview.targets}人）`,
        `・Discord に投稿したダジャレ（${preview.posts}件。公認のものも含みます）`,
        "",
        "解除したあとにまた使うには、/link で推しにもう一度連携してもらう必要があります。",
        "この確認は60秒で無効になります。",
      ].join("\n"),
      buttons: [
        { customId: `${CONFIRM_PREFIX}${nonce}`, label: "解除する", style: "danger" },
        { customId: `${CANCEL_PREFIX}${nonce}`, label: "キャンセル", style: "secondary" },
      ],
    });
  }

  /** /unlink の確認ボタン。このクラスのボタンでなければ false */
  async handleButton(interaction: ButtonInteractionLike): Promise<boolean> {
    const { customId } = interaction;
    const confirm = customId.startsWith(CONFIRM_PREFIX);
    if (!confirm && !customId.startsWith(CANCEL_PREFIX)) return false;

    const nonce = customId.slice(confirm ? CONFIRM_PREFIX.length : CANCEL_PREFIX.length);
    const entry = this.pending.get(nonce);
    if (!entry || entry.expiresAt <= this.clock.now()) {
      this.pending.delete(nonce);
      await interaction.update(
        done(
          "この確認は無効です（60秒が過ぎたか、すでに使われました）。解除する場合は、もう一度 /unlink を実行してください。",
        ),
      );
      return true;
    }
    if (entry.userId !== interaction.userId) {
      await interaction.reply({
        ephemeral: true,
        content: "この確認は /unlink を実行した人だけが使えます。",
      });
      return true;
    }

    this.pending.delete(nonce);
    if (!confirm) {
      await interaction.update(done("解除をキャンセルしました。連携はそのままです。"));
      return true;
    }

    // 解除には Discord の投稿の削除などで時間がかかるため、先に応答しておく
    await interaction.deferUpdate();
    const result = await this.deps.link.unlink("manual");
    await interaction.editReply(
      done(
        result
          ? `Spoon 連携を解除しました（削除したダジャレの投稿: ${result.deletedPosts}件）。`
          : "すでに連携は解除されています。",
      ),
    );
    return true;
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [nonce, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(nonce);
    }
  }
}

/** ボタンを消した返信 */
function done(content: string): BotReply {
  return { content, buttons: [] };
}
