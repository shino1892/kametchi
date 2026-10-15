import type { DajarePostRepository } from "../db/dajare.js";
import { type Clock, systemClock } from "../spoon/clock.js";

export const APPROVE_EMOJI = "⭕";
export const REJECT_EMOJI = "❌";

/** 投票の受付期間（仕様書 §8.3。旧 kametti と同じ24時間） */
export const VOTING_PERIOD_MS = 24 * 60 * 60_000;

/** 投稿されたダジャレ候補の Discord のメッセージ（bot.ts が discord.js で実装する） */
export interface DajareMessageHandle {
  /** ボット以外の、そのリアクションの数 */
  countVotes(emoji: string): Promise<number>;
  /** 「🏆 公認ダジャレ！」に書き換える */
  markApproved(): Promise<void>;
  /** 削除する */
  delete(): Promise<void>;
}

export type VoteOutcome = "approved" | "rejected" | "pending" | "ignored";

export interface DajareVotingDeps {
  posts: DajarePostRepository;
  /** 確定する票数（VOTE_THRESHOLD） */
  threshold: number;
  clock?: Clock;
  onLog?: (type: string, detail?: Record<string, string | number>) => void;
}

/**
 * ダジャレの投票（仕様書 §8.3）。リアクションが付くたびに DB の記録と票数で確かめるため、
 * 再起動しても受付を続ける（旧 kametti の ReactionCollector はメモリ上だけだった）。
 *
 * - ⭕ が threshold 票: 公認に書き換え、状態を approved にする
 * - ❌ が threshold 票: 投稿を削除し、記録も消す
 * - 投稿から24時間を過ぎた投稿・公認済みの投稿・記録のない投稿は扱わない
 */
export class DajareVoting {
  private readonly clock: Clock;
  /** 同じ投稿のリアクションは1件ずつ順に処理する（同時に確定させない・取りこぼさない） */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DajareVotingDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async onReaction(
    messageId: string,
    emoji: string,
    message: () => Promise<DajareMessageHandle>,
  ): Promise<VoteOutcome> {
    if (emoji !== APPROVE_EMOJI && emoji !== REJECT_EMOJI) return "ignored";
    const previous = this.chains.get(messageId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.decide(messageId, emoji, message));
    this.chains.set(messageId, current);
    try {
      return await current;
    } finally {
      if (this.chains.get(messageId) === current) this.chains.delete(messageId);
    }
  }

  private async decide(
    messageId: string,
    emoji: string,
    message: () => Promise<DajareMessageHandle>,
  ): Promise<VoteOutcome> {
    const post = await this.deps.posts.get(messageId);
    if (post?.status !== "voting") return "ignored";
    if (this.clock.now() - post.createdAt.getTime() >= VOTING_PERIOD_MS) return "ignored";

    const handle = await message();
    const votes = await handle.countVotes(emoji);
    if (votes < this.deps.threshold) return "pending";

    if (emoji === APPROVE_EMOJI) {
      if (!(await this.deps.posts.approve(messageId))) return "ignored";
      await handle.markApproved();
      this.deps.onLog?.("dajare_approved");
      return "approved";
    }
    await handle.delete();
    await this.deps.posts.delete(messageId);
    this.deps.onLog?.("dajare_rejected");
    return "rejected";
  }

  /** Discord で投稿が削除されたら、記録も消す */
  async onMessageDeleted(messageId: string): Promise<void> {
    await this.deps.posts.delete(messageId);
  }
}
