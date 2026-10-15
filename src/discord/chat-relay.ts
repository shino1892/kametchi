import { CHAT_MAX_LENGTH, chatLength } from "../chat/chat-length.js";
import type { SendFailure, SendResult } from "../chat/chat-sender.js";

/** Discord の投稿に付けるリアクションと、理由の返信 */
export interface RelayOutcome {
  reaction: "✅" | "❌" | "⚠️";
  reply?: string;
}

export interface ChatRelayDeps {
  /** 配信に参加しているか */
  isJoined(): boolean;
  /** チャットを送る（ChatSender） */
  send(message: string): Promise<SendResult>;
}

const FAILURE_MESSAGES: Record<SendFailure, string> = {
  not_joined: "配信に参加していないため送れません。/join で参加してから送ってください。",
  rate_limited: "送信が多すぎるため送れませんでした。少し待ってから送ってください。",
  chat_unavailable:
    "配信のチャットが凍結されているか、ボットのチャットが禁止されているため送れませんでした。",
  forbidden:
    "チャットを送る権限がないため送れませんでした。/link で連携し直して、すべての権限を許可してもらってください。",
  not_live: "配信が終わっているため送れませんでした。",
  invalid: "Spoon に受け付けられませんでした（空の文章や、200文字を超える文章は送れません）。",
  queue_full: "送信を待っているコメントが多すぎるため送れませんでした。",
  unlinked: "Spoon との連携が解除されていたため送れませんでした。",
  error: "送信に失敗しました。時間をおいて送り直してください。",
};

/**
 * Discord のチャットチャンネルへの投稿を、ボットの名前で配信のチャットに送る（仕様書 §7.2）。
 * 送れたら ✅、送れなかったら ❌ と理由、送らなかったら ⚠️ と理由を返す。
 */
export class ChatRelay {
  constructor(private readonly deps: ChatRelayDeps) {}

  async handle(content: string): Promise<RelayOutcome> {
    const message = content.trim();
    if (message === "") {
      return {
        reaction: "⚠️",
        reply: "本文がないため送れません（画像やスタンプだけの投稿は送れません）。",
      };
    }
    const length = chatLength(message);
    if (length > CHAT_MAX_LENGTH) {
      return {
        reaction: "⚠️",
        reply: `${CHAT_MAX_LENGTH}文字を超えているため送れません（${length}文字。絵文字は2文字として数えます）。`,
      };
    }
    if (!this.deps.isJoined()) return { reaction: "⚠️", reply: FAILURE_MESSAGES.not_joined };

    const result = await this.deps.send(message);
    if (result.ok) return { reaction: "✅" };
    return {
      reaction: result.reason === "not_joined" ? "⚠️" : "❌",
      reply: FAILURE_MESSAGES[result.reason],
    };
  }
}
