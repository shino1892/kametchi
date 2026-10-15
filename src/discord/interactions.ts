/**
 * Discord の操作（スラッシュコマンド・ボタン）を、discord.js に依存しない形で表す。
 * コマンドの処理はこの形を相手に書き、テストでは偽物を、本番では discord.js の
 * インタラクションを包んだものを渡す（bot.ts）。
 */

export interface ButtonSpec {
  customId: string;
  label: string;
  style: "primary" | "secondary" | "danger";
  emoji?: string;
}

export interface BotReply {
  content: string;
  /** 付けるボタン。空の配列を渡すとボタンを消す */
  buttons?: ButtonSpec[];
}

export interface ReplyOptions extends BotReply {
  /** 実行した本人にだけ見える返信 */
  ephemeral?: boolean;
}

export interface CommandInteractionLike {
  userId: string;
  reply(reply: ReplyOptions): Promise<void>;
}

export interface ButtonInteractionLike {
  userId: string;
  customId: string;
  /** ボタンが付いたメッセージを書き換える */
  update(reply: BotReply): Promise<void>;
  /** 新しい返信を送る */
  reply(reply: ReplyOptions): Promise<void>;
  /** 時間のかかる処理の前に応答しておく（あとで editReply で書き換える） */
  deferUpdate(): Promise<void>;
  editReply(reply: BotReply): Promise<void>;
}
