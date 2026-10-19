import type { JoinResult, LeaveReason, LiveSession } from "../live/live-session.js";
import type { LiveWatcher } from "../live/live-watcher.js";
import type { LiveInfo } from "../spoon/api.js";
import type {
  BotReply,
  ButtonInteractionLike,
  ButtonSpec,
  CommandInteractionLike,
} from "./interactions.js";

const JOIN_PREFIX = "live:join:";
const LEAVE_ID = "live:leave";

const NOT_LINKED = "Spoon と連携していません。/link で配信者に連携してもらってください。";

export interface LiveCommandsDeps {
  session: Pick<LiveSession, "join" | "leave" | "isJoined" | "current">;
  watcher: Pick<LiveWatcher, "current">;
  isLinked(): boolean;
  /** Discord のメインチャンネルへの通知 */
  notify(message: BotReply): Promise<void>;
}

/**
 * 配信の通知と、手動の参加・退室（仕様書 §6.1、§6.2）。
 * 配信を検知したら「配信に参加」ボタン付きで知らせ、/join・ボタンで参加、/leave・「退室」ボタンで退室する。
 */
export class LiveCommands {
  /** 「配信が終了しました」を知らせた配信（検知と退室の両方から重ねて知らせない） */
  private endNotified: number | null = null;

  constructor(private readonly deps: LiveCommandsDeps) {}

  // ---- 通知 ----

  async onLiveStarted(live: LiveInfo): Promise<void> {
    await this.deps.notify({
      content: [
        "🎙️ **配信が始まりました**",
        live.title ? `タイトル: ${live.title}` : null,
        "ボットを参加させるときは、下のボタンか /join を使ってください。",
      ]
        .filter((line) => line !== null)
        .join("\n"),
      buttons: [joinButton(live.liveId)],
    });
  }

  async onLiveEnded(live: LiveInfo): Promise<void> {
    await this.notifyEnded(live.liveId);
  }

  /** 参加中に退室した。手動の退室は操作した人への返信で伝えるため、ここでは知らせない */
  async onLeft(reason: LeaveReason, live: LiveInfo | null): Promise<void> {
    if (reason === "manual" || reason === "unlinked") return;
    if (reason === "live_ended") {
      if (live) await this.notifyEnded(live.liveId, true);
      return;
    }
    await this.deps.notify({ content: leftMessage(reason) });
  }

  // ---- 操作 ----

  async handleJoinCommand(interaction: CommandInteractionLike): Promise<void> {
    const precheck = this.precheckJoin();
    if (precheck) {
      await interaction.reply({ ...precheck, ephemeral: true });
      return;
    }
    await interaction.deferReply();
    await interaction.editReply(joinReply(await this.deps.session.join()));
  }

  async handleLeaveCommand(interaction: CommandInteractionLike): Promise<void> {
    if (!this.deps.session.isJoined()) {
      await interaction.reply({ ephemeral: true, content: "配信に参加していません。" });
      return;
    }
    await interaction.deferReply();
    await this.deps.session.leave("manual");
    await interaction.editReply({ content: "👋 配信から退室しました。" });
  }

  /** 「配信に参加」「退室」ボタン。このクラスのボタンでなければ false */
  async handleButton(interaction: ButtonInteractionLike): Promise<boolean> {
    if (interaction.customId === LEAVE_ID) {
      await interaction.deferUpdate();
      const left = await this.deps.session.leave("manual");
      await interaction.editReply({
        content: left
          ? "👋 配信から退室しました。"
          : "配信に参加していません（すでに退室しています）。",
        buttons: [],
      });
      return true;
    }

    if (!interaction.customId.startsWith(JOIN_PREFIX)) return false;
    const liveId = Number(interaction.customId.slice(JOIN_PREFIX.length));
    // 終わった配信の通知のボタンでは参加しない
    if (this.deps.watcher.current()?.liveId !== liveId) {
      await interaction.reply({
        ephemeral: true,
        content: "この配信は終了しています。配信中なら /join を使ってください。",
      });
      return true;
    }
    const precheck = this.precheckJoin();
    if (precheck) {
      await interaction.reply({ ...precheck, ephemeral: true });
      return true;
    }
    await interaction.deferReply();
    await interaction.editReply(joinReply(await this.deps.session.join()));
    return true;
  }

  /** すぐに答えられる場合（連携していない・参加中）の返信 */
  private precheckJoin(): BotReply | null {
    if (!this.deps.isLinked()) return { content: NOT_LINKED };
    if (this.deps.session.isJoined()) {
      return { content: "すでに配信に参加しています。", buttons: [leaveButton()] };
    }
    return null;
  }

  private async notifyEnded(liveId: number, botLeft = false): Promise<void> {
    if (this.endNotified === liveId) return;
    this.endNotified = liveId;
    await this.deps.notify({
      content: botLeft
        ? "📴 配信が終了しました。ボットも退室しました。"
        : "📴 配信が終了しました。",
    });
  }
}

function joinReply(result: JoinResult): BotReply {
  switch (result.kind) {
    case "joined":
    case "already_joined":
      return {
        content: [
          "✅ 配信に参加しました。",
          result.live?.title ? `タイトル: ${result.live.title}` : null,
          "ボットが参加したことは、Spoon が配信のチャットで自動的にお知らせします。",
        ]
          .filter((line) => line !== null)
          .join("\n"),
        buttons: [leaveButton()],
      };
    case "not_linked":
      return { content: NOT_LINKED };
    case "not_live":
      return { content: "今は配信していません。" };
    case "failed":
      return { content: failedMessage(result.reason) };
  }
}

function failedMessage(reason: LeaveReason): string {
  switch (reason) {
    case "manual":
      return "参加を取りやめました。";
    case "live_ended":
      return "今は配信していません。";
    case "unlinked":
      return "Spoon との連携が解除されていたため、参加できませんでした。";
    default:
      return leftMessage(reason).replace("退室しました", "参加できませんでした");
  }
}

function leftMessage(reason: Exclude<LeaveReason, "manual" | "live_ended" | "unlinked">): string {
  switch (reason) {
    case "duplicate_connection":
      return "⚠️ 別の場所から配信に接続されたため、ボットは退室しました。kametchi を重複して起動していないか確認してください。";
    case "blocked":
      return "⚠️ 配信者がボットの入室をブロックしているため、ボットは退室しました。";
    case "forbidden":
      return "⚠️ 権限が足りないため、ボットは退室しました。/link で連携し直して、すべての権限を許可してもらってください。";
  }
}

function joinButton(liveId: number): ButtonSpec {
  return {
    customId: `${JOIN_PREFIX}${liveId}`,
    label: "配信に参加",
    style: "primary",
    emoji: "🎧",
  };
}

function leaveButton(): ButtonSpec {
  return { customId: LEAVE_ID, label: "退室", style: "danger", emoji: "👋" };
}
