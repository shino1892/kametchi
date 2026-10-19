/**
 * イベントストリーム（GET /v1/live/events）の payload を、kametchi が使う最小限の形に変換する。
 *
 * 権限を要求していない presence・donation と、使わない値（like の amount・combo など）は
 * ここで捨てる。チャット本文はダジャレ判定と DJ のコマンドのためにメモリ上でだけ使い、
 * DB・ログには残さない（仕様書 §0、§9.2）。
 */

export interface Listener {
  /** 公式の暗号化識別子。ボット×DJの組み合わせごとに一意 */
  id: string;
  nickname: string | null;
}

export type HeartType = "FREE" | "PAID";

export const END_REASONS = [
  "LIVE_ENDED",
  "TOKEN_EXPIRED",
  "RECONNECT",
  "DUPLICATE_CONNECTION",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export type ChatEvent = {
  kind: "chat";
  user: Listener;
  /** DJ 本人の発言か */
  isDj: boolean;
  /** 本文。保存・ログ出力はしない */
  message: string;
  at: number;
};
export type LikeEvent = {
  kind: "like";
  user: Listener;
  heartType: HeartType;
  /** 実際に届いたハート数（(amount + extraAmount) × combo） */
  hearts: number;
  at: number;
};
export type EndEvent = { kind: "end"; reason: EndReason };

export type ListenerActivityEvent = ChatEvent | LikeEvent;
export type LiveEvent = ListenerActivityEvent | EndEvent;

export type ParseFailure =
  | "unknown_event"
  | "invalid_json"
  | "invalid_payload"
  | "unsupported_type";
export type ParseResult = { ok: true; event: LiveEvent } | { ok: false; reason: ParseFailure };

/**
 * SSE の `event:` 名と `data:` 文字列から LiveEvent を作る。
 * 未知のイベントや不正な payload は失敗として返し、呼び出し側で破棄する。
 */
export function parseLiveEvent(eventName: string, data: string): ParseResult {
  const parser = PARSERS[eventName];
  if (!parser) return fail("unknown_event");

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return fail("invalid_json");
  }
  if (!isRecord(payload)) return fail("invalid_payload");
  return parser(payload);
}

type Payload = Record<string, unknown>;

const PARSERS: Record<string, (p: Payload) => ParseResult> = {
  chat(p) {
    const user = readListener(p.user);
    const at = readTime(p.sentTime);
    if (!user || at === null || typeof p.isDj !== "boolean" || typeof p.message !== "string") {
      return fail("invalid_payload");
    }
    return ok({ kind: "chat", user, isDj: p.isDj, message: p.message, at });
  },

  like(p) {
    const user = readListener(p.user);
    const at = readTime(p.time);
    const hearts = readCount(p.totalAmount);
    if (!user || at === null || hearts === null) return fail("invalid_payload");
    if (p.type !== "FREE" && p.type !== "PAID") return fail("unsupported_type");
    return ok({ kind: "like", user, heartType: p.type, hearts, at });
  },

  end(p) {
    const reason = p.reason;
    if (typeof reason !== "string" || !isEndReason(reason)) return fail("invalid_payload");
    return ok({ kind: "end", reason });
  },
};

function ok(event: LiveEvent): ParseResult {
  return { ok: true, event };
}

function fail(reason: ParseFailure): ParseResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEndReason(value: string): value is EndReason {
  return (END_REASONS as readonly string[]).includes(value);
}

function readListener(value: unknown): Listener | null {
  if (!isRecord(value)) return null;
  const { id, nickname } = value;
  if (typeof id !== "string" || id === "") return null;
  if (nickname !== null && nickname !== undefined && typeof nickname !== "string") return null;
  return { id, nickname: nickname ?? null };
}

/** ISO-8601 の時刻を epoch ミリ秒にする */
function readTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 0 以上の整数だけを件数・数量として受け付ける */
function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
