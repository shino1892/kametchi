import { describe, expect, it } from "vitest";
import { parseLiveEvent } from "../../src/spoon/events.js";

// 公式ドキュメント（イベントストリーム）の payload 例に基づく
const user = { id: "Ab1Cd2Ef3Gh4Ij5Kl6Mn7O", nickname: "スプーンリスナー" };
const at = "2026-09-02T05:47:26.114Z";
const atMs = Date.parse(at);

function parse(event: string, payload: unknown) {
  return parseLiveEvent(event, JSON.stringify(payload));
}

describe("parseLiveEvent", () => {
  it("chat: 送り主・isDj・本文・時刻を取り出す（本文はダジャレ判定とコマンドに使う）", () => {
    const result = parse("chat", { user, isDj: false, message: "こんにちは", sentTime: at });
    expect(result).toEqual({
      ok: true,
      event: { kind: "chat", user, isDj: false, message: "こんにちは", at: atMs },
    });
  });

  it("chat: DJ の発言は isDj: true として残す", () => {
    const result = parse("chat", { user, isDj: true, message: "!ハート off", sentTime: at });
    expect(result.ok && result.event.kind === "chat" && result.event.isDj).toBe(true);
  });

  it("like: totalAmount を実際に届いたハート数として使う", () => {
    const result = parse("like", {
      user,
      type: "PAID",
      totalAmount: 30,
      amount: 10,
      extraAmount: 5,
      combo: 2,
      time: at,
    });
    expect(result).toEqual({
      ok: true,
      event: { kind: "like", user, heartType: "PAID", hearts: 30, at: atMs },
    });
  });

  it("like: 無料ハート（combo: null）を受け付ける", () => {
    const result = parse("like", {
      user,
      type: "FREE",
      totalAmount: 1,
      amount: 1,
      extraAmount: 0,
      combo: null,
      time: at,
    });
    expect(result.ok && result.event.kind === "like" && result.event.heartType).toBe("FREE");
  });

  it("like: 未知の type は解釈しない", () => {
    const result = parse("like", { user, type: "SUPER", totalAmount: 1, time: at });
    expect(result).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("ニックネームが null のリスナーを受け付ける", () => {
    const result = parse("like", {
      user: { id: "x", nickname: null },
      type: "FREE",
      totalAmount: 1,
      time: at,
    });
    expect(result.ok && result.event.kind === "like" && result.event.user.nickname).toBeNull();
  });

  it.each(["LIVE_ENDED", "TOKEN_EXPIRED", "RECONNECT", "DUPLICATE_CONNECTION"])(
    "end: reason %s を受け付ける",
    (reason) => {
      expect(parse("end", { reason })).toEqual({ ok: true, event: { kind: "end", reason } });
    },
  );

  it.each(["presence", "donation", "gift_box"])(
    "権限を要求していない・未知のイベント（%s）は失敗として返す",
    (event) => {
      expect(parse(event, { user, time: at })).toEqual({ ok: false, reason: "unknown_event" });
    },
  );

  it("JSON でない data は失敗として返す", () => {
    expect(parseLiveEvent("chat", "{broken")).toEqual({ ok: false, reason: "invalid_json" });
  });

  it.each([
    ["user がない", { isDj: false, message: "a", sentTime: at }],
    ["user.id が空", { user: { id: "", nickname: "a" }, isDj: false, message: "a", sentTime: at }],
    ["時刻が不正", { user, isDj: false, message: "a", sentTime: "yesterday" }],
    ["isDj が文字列", { user, isDj: "false", message: "a", sentTime: at }],
    ["message がない", { user, isDj: false, sentTime: at }],
  ])("chat: %s なら invalid_payload", (_, payload) => {
    expect(parse("chat", payload)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it.each([
    ["負の値", -1],
    ["小数", 1.5],
    ["文字列", "10"],
  ])("like: totalAmount が%sなら invalid_payload", (_, totalAmount) => {
    expect(parse("like", { user, type: "FREE", totalAmount, time: at })).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("payload が配列なら invalid_payload", () => {
    expect(parse("chat", [])).toEqual({ ok: false, reason: "invalid_payload" });
  });
});
