import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DajareTargets, RECENT_CHATTERS } from "../../src/dajare/targets.js";
import {
  APPROVE_EMOJI,
  type DajareMessageHandle,
  DajareVoting,
  REJECT_EMOJI,
  VOTING_PERIOD_MS,
} from "../../src/dajare/voting.js";
import { ConnectionRepository } from "../../src/db/connection.js";
import { DajarePostRepository, DajareTargetRepository } from "../../src/db/dajare.js";
import type { Database } from "../../src/db/database.js";
import { TokenCipher } from "../../src/db/token-cipher.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { createTestDatabase } from "../helpers/test-db.js";

let db: Database;
let connectionId: string;

beforeEach(async () => {
  db = await createTestDatabase();
  const connections = new ConnectionRepository(db, new TokenCipher(randomBytes(32)));
  connectionId = (
    await connections.save({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["live.read"],
    })
  ).id;
});
afterEach(() => db.close());

describe("DajareTargets", () => {
  async function setup() {
    const targets = new DajareTargets(new DajareTargetRepository(db));
    await targets.load(connectionId);
    return targets;
  }

  it("最近チャットした人の中からだけ登録できる（ID を推測して登録させない）", async () => {
    const targets = await setup();
    expect(await targets.add("u1", "しえる")).toBe(false);
    targets.noteChatter({ id: "u1", nickname: "しえる" });
    expect(await targets.add("u1", "しえる")).toBe(true);
    expect(targets.isTarget("u1")).toBe(true);
    expect(targets.list()).toEqual([{ userId: "u1", memo: "しえる" }]);
  });

  it("登録は DB に残り、読み込み直しても使える。最近チャットした人は残らない", async () => {
    const targets = await setup();
    targets.noteChatter({ id: "u1", nickname: "しえる" });
    await targets.add("u1", "しえる");

    const reloaded = await setup();
    expect(reloaded.isTarget("u1")).toBe(true);
    expect(reloaded.recentChatters()).toEqual([]);
  });

  it("登録を外す", async () => {
    const targets = await setup();
    targets.noteChatter({ id: "u1", nickname: null });
    await targets.add("u1", "A");
    expect(await targets.remove("u1")).toBe(true);
    expect(await targets.remove("u1")).toBe(false);
    expect(targets.isTarget("u1")).toBe(false);
  });

  it("最近チャットした人は新しい順に、最大25人まで覚え、退室で消す", async () => {
    const targets = await setup();
    for (let i = 0; i < RECENT_CHATTERS + 5; i++) {
      targets.noteChatter({ id: `u${i}`, nickname: `N${i}` });
    }
    targets.noteChatter({ id: "u10", nickname: "N10" });
    const recent = targets.recentChatters();
    expect(recent).toHaveLength(RECENT_CHATTERS);
    expect(recent[0]).toEqual({ id: "u10", nickname: "N10" });
    expect(recent.some((l) => l.id === "u0")).toBe(false);

    targets.forgetChatters();
    expect(targets.recentChatters()).toEqual([]);
  });

  it("連携していなければ何も登録しない", async () => {
    const targets = new DajareTargets(new DajareTargetRepository(db));
    await targets.load(null);
    targets.noteChatter({ id: "u1", nickname: null });
    expect(await targets.add("u1", "A")).toBe(false);
  });
});

describe("DajareVoting", () => {
  const NOW = Date.parse("2026-10-15T12:00:00Z");

  function setup(threshold = 4) {
    const clock = new FakeClock(NOW);
    const posts = new DajarePostRepository(db);
    const voting = new DajareVoting({ posts, threshold, clock });
    const votes = new Map<string, number>();
    const actions: string[] = [];
    const handle: DajareMessageHandle = {
      countVotes: async (emoji) => votes.get(emoji) ?? 0,
      markApproved: async () => void actions.push("approved"),
      delete: async () => void actions.push("deleted"),
    };
    const react = (messageId: string, emoji: string) =>
      voting.onReaction(messageId, emoji, async () => handle);
    return { clock, posts, voting, votes, actions, react };
  }

  async function addPost(posts: DajarePostRepository, messageId: string, createdAt = NOW) {
    await posts.add(connectionId, "c1", messageId);
    await db.query("UPDATE dajare_posts SET created_at = $1 WHERE message_id = $2", [
      new Date(createdAt),
      messageId,
    ]);
  }

  it("⭕ が票数に達したら公認にする（1回だけ）", async () => {
    const t = setup();
    await addPost(t.posts, "m1");
    t.votes.set(APPROVE_EMOJI, 3);
    expect(await t.react("m1", APPROVE_EMOJI)).toBe("pending");
    t.votes.set(APPROVE_EMOJI, 4);
    expect(await t.react("m1", APPROVE_EMOJI)).toBe("approved");
    expect(await t.react("m1", APPROVE_EMOJI)).toBe("ignored");
    expect(t.actions).toEqual(["approved"]);
    expect((await t.posts.get("m1"))?.status).toBe("approved");
  });

  it("❌ が票数に達したら、投稿と記録を消す", async () => {
    const t = setup();
    await addPost(t.posts, "m1");
    t.votes.set(REJECT_EMOJI, 4);
    expect(await t.react("m1", REJECT_EMOJI)).toBe("rejected");
    expect(t.actions).toEqual(["deleted"]);
    expect(await t.posts.get("m1")).toBeNull();
  });

  it("公認のあとに ❌ が増えても消さない", async () => {
    const t = setup();
    await addPost(t.posts, "m1");
    t.votes.set(APPROVE_EMOJI, 4);
    await t.react("m1", APPROVE_EMOJI);
    t.votes.set(REJECT_EMOJI, 4);
    expect(await t.react("m1", REJECT_EMOJI)).toBe("ignored");
    expect(t.actions).toEqual(["approved"]);
  });

  it("投稿から24時間を過ぎたら受け付けない", async () => {
    const t = setup();
    await addPost(t.posts, "m1", NOW - VOTING_PERIOD_MS);
    t.votes.set(APPROVE_EMOJI, 10);
    expect(await t.react("m1", APPROVE_EMOJI)).toBe("ignored");
  });

  it("記録のない投稿・ほかの絵文字は扱わない", async () => {
    const t = setup();
    t.votes.set(APPROVE_EMOJI, 10);
    expect(await t.react("unknown", APPROVE_EMOJI)).toBe("ignored");
    await addPost(t.posts, "m1");
    expect(await t.react("m1", "👍")).toBe("ignored");
    expect(t.actions).toEqual([]);
  });

  it("同じ投稿へのリアクションが同時に届いても、1件ずつ処理して取りこぼさない", async () => {
    const t = setup();
    await addPost(t.posts, "m1");
    t.votes.set(APPROVE_EMOJI, 4);
    const results = await Promise.all([
      t.react("m1", APPROVE_EMOJI),
      t.react("m1", APPROVE_EMOJI),
      t.react("m1", APPROVE_EMOJI),
    ]);
    expect(results).toEqual(["approved", "ignored", "ignored"]);
    expect(t.actions).toEqual(["approved"]);
  });

  it("Discord で投稿が消されたら、記録も消す", async () => {
    const t = setup();
    await addPost(t.posts, "m1");
    await t.voting.onMessageDeleted("m1");
    expect(await t.posts.get("m1")).toBeNull();
  });
});
