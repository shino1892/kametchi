/**
 * 推しが配信中のチャットで送るコマンド（仕様書 §7.4）。
 *
 *   !ハート on / !ハート off   … ハートコメントのオン・オフ（別名: !heart）
 *
 * 「！」（全角）や全角スペース、「オン」「オフ」も受け付ける。
 * 推し本人の発言（isDj: true）だけを解釈する。結果は配信のチャットには投稿しない。
 */

export type DjCommand = { type: "heart"; enabled: boolean };

const TARGETS = new Set(["ハート", "heart"]);

const SWITCHES: Record<string, boolean> = {
  on: true,
  オン: true,
  off: false,
  オフ: false,
};

export function parseDjCommand(message: string): DjCommand | null {
  const normalized = message
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized.startsWith("!")) return null;

  const [name = "", argument, ...rest] = normalized.slice(1).split(" ");
  if (!TARGETS.has(name) || argument === undefined || rest.length > 0) return null;
  const enabled = SWITCHES[argument];
  return enabled === undefined ? null : { type: "heart", enabled };
}
