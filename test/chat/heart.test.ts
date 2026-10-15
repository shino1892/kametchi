import { describe, expect, it } from "vitest";
import { CHAT_MAX_LENGTH, chatLength } from "../../src/chat/chat-length.js";
import type { SendResult } from "../../src/chat/chat-sender.js";
import { parseDjCommand } from "../../src/chat/dj-commands.js";
import {
  HEART_COMMENT,
  HeartCommenter,
  isHeartCommentTarget,
} from "../../src/chat/heart-comment.js";
import type { LikeEvent } from "../../src/spoon/events.js";

const like = (heartType: "FREE" | "PAID", hearts = 1, id = "a"): LikeEvent => ({
  kind: "like",
  user: { id, nickname: null },
  heartType,
  hearts,
  at: 0,
});

describe("ハートコメントの文面", () => {
  it("旧 kametti と同じ4行で、Spoon の上限（200文字）に収まる", () => {
    expect(HEART_COMMENT.split("\n")).toHaveLength(4);
    expect(HEART_COMMENT).toContain("ｼ ｭ ﾜ ー ｯ ﾁ !!");
    expect(chatLength(HEART_COMMENT)).toBe(58);
    expect(chatLength(HEART_COMMENT)).toBeLessThanOrEqual(CHAT_MAX_LENGTH);
  });
});

describe("isHeartCommentTarget", () => {
  it("無料ハート、または有料ハート1個だけが対象（バスターなどは対象外）", () => {
    expect(isHeartCommentTarget(like("FREE"))).toBe(true);
    expect(isHeartCommentTarget(like("FREE", 5))).toBe(true);
    expect(isHeartCommentTarget(like("PAID", 1))).toBe(true);
    expect(isHeartCommentTarget(like("PAID", 2))).toBe(false);
    expect(isHeartCommentTarget(like("PAID", 10))).toBe(false);
  });
});

describe("HeartCommenter", () => {
  function setup(enabled = true) {
    const sent: string[] = [];
    const resolvers: Array<(result: SendResult) => void> = [];
    let on = enabled;
    const commenter = new HeartCommenter({
      enabled: () => on,
      send: (message) => {
        sent.push(message);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });
    const finishSending = async () => {
      for (const resolve of resolvers.splice(0)) resolve({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { commenter, sent, finishSending, setEnabled: (value: boolean) => (on = value) };
  }

  it("送信待ちのハートコメントがあるあいだのハートは、1回にまとめる（同じ人・複数人とも）", async () => {
    const t = setup();
    expect(t.commenter.handle(like("FREE", 1, "a"))).toBe(true);
    expect(t.commenter.handle(like("FREE", 1, "a"))).toBe(false);
    expect(t.commenter.handle(like("PAID", 1, "b"))).toBe(false);
    expect(t.sent).toEqual([HEART_COMMENT]);

    // 送り終わったら、次のハートでまた送る
    await t.finishSending();
    expect(t.commenter.handle(like("FREE", 1, "c"))).toBe(true);
    expect(t.sent).toHaveLength(2);
  });

  it("対象外のハートには送らない", () => {
    const t = setup();
    expect(t.commenter.handle(like("PAID", 10))).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it("オフなら送らない", () => {
    const t = setup(false);
    expect(t.commenter.handle(like("FREE"))).toBe(false);
    t.setEnabled(true);
    expect(t.commenter.handle(like("FREE"))).toBe(true);
  });

  it("送信に失敗しても、次のハートでまた送る", async () => {
    const sent: string[] = [];
    const commenter = new HeartCommenter({
      enabled: () => true,
      send: async (message) => {
        sent.push(message);
        throw new Error("failed");
      },
    });
    commenter.handle(like("FREE"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commenter.handle(like("FREE"))).toBe(true);
    expect(sent).toHaveLength(2);
  });
});

describe("parseDjCommand", () => {
  it.each([
    ["!ハート on", true],
    ["!ハート off", false],
    ["！ハート　オン", true],
    ["!heart OFF", false],
    ["  !ハート   オフ  ", false],
  ])("%s を読む", (message, enabled) => {
    expect(parseDjCommand(message)).toEqual({ type: "heart", enabled });
  });

  it.each(["ハート on", "!ハート", "!ハート on です", "!bot on", "!ハート maybe", "こんにちは"])(
    "%s はコマンドとして読まない",
    (message) => {
      expect(parseDjCommand(message)).toBeNull();
    },
  );
});
