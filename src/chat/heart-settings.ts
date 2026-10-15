import { DEFAULT_SETTINGS, type SettingsRepository } from "../db/settings.js";

/**
 * ハートコメントのオン・オフ（仕様書 §7.4）。配信者のチャットコマンドと Discord の /heart から
 * 同じ設定を変える。ハートのたびに DB を読まないよう、連携中の値をメモリに持つ。
 */
export class HeartSettings {
  private connectionId: string | null = null;
  private value = DEFAULT_SETTINGS.heartComment;

  constructor(private readonly repository: SettingsRepository) {}

  /** 連携した・起動したときに読み込む。連携していなければ null を渡す */
  async load(connectionId: string | null): Promise<void> {
    this.connectionId = connectionId;
    this.value = connectionId
      ? (await this.repository.get(connectionId)).heartComment
      : DEFAULT_SETTINGS.heartComment;
  }

  enabled(): boolean {
    return this.connectionId !== null && this.value;
  }

  /** 設定を変えて保存する。連携していなければ false */
  async set(enabled: boolean): Promise<boolean> {
    const connectionId = this.connectionId;
    if (!connectionId) return false;
    const saved = await this.repository.update(connectionId, { heartComment: enabled });
    // 保存の途中で解除・連携し直しがあった場合は、新しい連携の値を上書きしない
    if (this.connectionId === connectionId) this.value = saved.heartComment;
    return true;
  }
}
