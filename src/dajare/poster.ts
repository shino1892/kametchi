import type { DajarePostRepository } from "../db/dajare.js";
import type { ChatEvent } from "../spoon/events.js";
import type { DajareJudge } from "./shareka.js";
import type { DajareTargets } from "./targets.js";

/** ニックネームがないときの呼び方 */
export const FALLBACK_NICKNAME = "リスナー";

export interface DajarePosterDeps {
  judge: Pick<DajareJudge, "judge">;
  targets: Pick<DajareTargets, "isTarget" | "noteChatter">;
  posts: Pick<DajarePostRepository, "add">;
  /** 連携の ID。連携していなければ null */
  connectionId(): string | null;
  /** Discord のダジャレチャンネルに投稿する（⭕/❌ も付ける） */
  post(nickname: string, text: string): Promise<{ channelId: string; messageId: string }>;
  /** 記録できなかった投稿を消す */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  onLog?: (type: string, detail?: Record<string, string | number>) => void;
}

/**
 * 参加中の配信のチャットからダジャレ候補を見つけて Discord に投稿する（仕様書 §8）。
 *
 * - 判定するのは登録した対象（本人の了承を得たリスナー）のチャットだけ。配信者本人の発言は判定しない
 * - 本文はここで判定と投稿に使うだけで、DB・ログには残さない。DB にはメッセージ ID だけを記録する
 */
export class DajarePoster {
  constructor(private readonly deps: DajarePosterDeps) {}

  /** チャットを受け取った。ダジャレ候補として投稿したら true */
  async handleChat(event: ChatEvent): Promise<boolean> {
    if (event.isDj) return false;
    this.deps.targets.noteChatter(event.user);
    if (!this.deps.targets.isTarget(event.user.id)) return false;
    if (!this.deps.judge.judge(event.message)) return false;

    const connectionId = this.deps.connectionId();
    if (!connectionId) return false;
    const nickname = event.user.nickname?.trim() || FALLBACK_NICKNAME;
    const posted = await this.deps.post(nickname, event.message.trim());
    try {
      await this.deps.posts.add(connectionId, posted.channelId, posted.messageId);
    } catch (error) {
      // 記録できない投稿は連携解除のときに消せないため、残さない
      await this.deps.deleteMessage(posted.channelId, posted.messageId).catch(() => {});
      throw error;
    }
    this.deps.onLog?.("dajare_posted");
    return true;
  }
}
