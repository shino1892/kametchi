import type { DajareTarget, DajareTargetRepository } from "../db/dajare.js";
import type { Listener } from "../spoon/events.js";

/** 最近チャットした人として覚えておく人数（Discord の選択肢の上限が25件のため） */
export const RECENT_CHATTERS = 25;

/**
 * ダジャレ判定の対象（仕様書 §8.1）。登録した対象は DB に保存し、チャットのたびに
 * DB を読まないようメモリにも持つ。
 *
 * 「最近チャットした人」は、対象を登録するときに選ぶためだけの一覧で、メモリ上だけに持ち、
 * 退室したら消す（DB・ログには残さない）。
 */
export class DajareTargets {
  private connectionId: string | null = null;
  private targets = new Map<string, string>();
  /** 最近チャットした人（新しい順）。user.id → ニックネーム */
  private readonly recent = new Map<string, string | null>();

  constructor(private readonly repository: DajareTargetRepository) {}

  /** 連携した・起動したときに読み込む。連携していなければ null を渡す */
  async load(connectionId: string | null): Promise<void> {
    this.connectionId = connectionId;
    this.recent.clear();
    const list = connectionId ? await this.repository.list(connectionId) : [];
    this.targets = new Map(list.map((target) => [target.userId, target.memo]));
  }

  isTarget(userId: string): boolean {
    return this.targets.has(userId);
  }

  list(): DajareTarget[] {
    return [...this.targets].map(([userId, memo]) => ({ userId, memo }));
  }

  /** 登録する。最近チャットした人の中にいなければ false（ID を推測して登録させない） */
  async add(userId: string, memo: string): Promise<boolean> {
    const connectionId = this.connectionId;
    if (!connectionId || !this.recent.has(userId)) return false;
    await this.repository.add(connectionId, { userId, memo });
    this.targets.set(userId, memo);
    return true;
  }

  /** 登録を外す。登録していなければ false */
  async remove(userId: string): Promise<boolean> {
    const connectionId = this.connectionId;
    if (!connectionId || !this.targets.has(userId)) return false;
    await this.repository.remove(connectionId, userId);
    this.targets.delete(userId);
    return true;
  }

  /** チャットした人を覚える（推し本人の発言は含めない） */
  noteChatter(user: Listener): void {
    this.recent.delete(user.id);
    this.recent.set(user.id, user.nickname);
    while (this.recent.size > RECENT_CHATTERS) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  /** 最近チャットした人（新しい順） */
  recentChatters(): Listener[] {
    return [...this.recent].reverse().map(([id, nickname]) => ({ id, nickname }));
  }

  /** 退室したら、最近チャットした人の一覧を消す */
  forgetChatters(): void {
    this.recent.clear();
  }
}
