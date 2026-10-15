import type { LikeEvent } from "../spoon/events.js";
import type { SendResult } from "./chat-sender.js";

/** ハートコメントの文面（旧 kametti と同じ。仕様書 §7.3） */
export const HEART_COMMENT = [
  "𓂃 ❥ 𓊝𓂃𓂃𓂃𓂃𓂃𓂃",
  "　　　　　　 𓈒𓏸",
  "　　　ｼ ｭ ﾜ ー ｯ ﾁ !!",
  "　　　　　 .゜",
].join("\n");

/** ハートコメントを送るハートか。無料ハート、または有料ハート1個だけ（バスターなどには送らない） */
export function isHeartCommentTarget(event: LikeEvent): boolean {
  return event.heartType === "FREE" || (event.heartType === "PAID" && event.hearts === 1);
}

export interface HeartCommenterDeps {
  /** ハートコメントがオンか */
  enabled(): boolean;
  /** チャットを送る（ChatSender） */
  send(message: string): Promise<SendResult>;
}

/**
 * ハートが届いたらハートコメントを送る（仕様書 §7.3）。
 *
 * 送信待ちのハートコメントがあるあいだに届いたハートには新しく積まない（1回にまとめる）。
 * 送信の間隔は ChatSender が空けるため、ハートコメントがそれより短い間隔で続くことはない。
 */
export class HeartCommenter {
  private pending = false;

  constructor(private readonly deps: HeartCommenterDeps) {}

  /** ハートを受け取った。ハートコメントを送ることにしたら true */
  handle(event: LikeEvent): boolean {
    if (!this.deps.enabled() || !isHeartCommentTarget(event) || this.pending) return false;
    this.pending = true;
    void this.deps
      .send(HEART_COMMENT)
      .catch(() => {})
      .finally(() => {
        this.pending = false;
      });
    return true;
  }
}
