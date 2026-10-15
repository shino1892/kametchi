import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionRepository } from "../../src/db/connection.js";
import { DajarePostRepository, DajareTargetRepository } from "../../src/db/dajare.js";
import type { Database } from "../../src/db/database.js";
import { SettingsRepository } from "../../src/db/settings.js";
import { TokenCipher } from "../../src/db/token-cipher.js";
import { createTestDatabase } from "../helpers/test-db.js";

let db: Database;
let connectionId: string;

beforeEach(async () => {
  db = await createTestDatabase();
  const connections = new ConnectionRepository(db, new TokenCipher(randomBytes(32)));
  const connection = await connections.save({
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["live.read"],
  });
  connectionId = connection.id;
});
afterEach(() => db.close());

describe("SettingsRepository", () => {
  it("行がなければハートコメントはオン。変えた値を保存する", async () => {
    const settings = new SettingsRepository(db);
    expect(await settings.get(connectionId)).toEqual({ heartComment: true });
    expect(await settings.update(connectionId, { heartComment: false })).toEqual({
      heartComment: false,
    });
    expect(await settings.get(connectionId)).toEqual({ heartComment: false });
    expect(await settings.update(connectionId, {})).toEqual({ heartComment: false });
  });
});

describe("DajareTargetRepository", () => {
  it("登録・メモの更新・一覧・解除", async () => {
    const targets = new DajareTargetRepository(db);
    await targets.add(connectionId, { userId: "u1", memo: "しえる" });
    await targets.add(connectionId, { userId: "u2", memo: "B" });
    await targets.add(connectionId, { userId: "u1", memo: "しえるさん" });
    expect(await targets.list(connectionId)).toEqual([
      { userId: "u1", memo: "しえるさん" },
      { userId: "u2", memo: "B" },
    ]);

    expect(await targets.remove(connectionId, "u2")).toBe(true);
    expect(await targets.remove(connectionId, "u2")).toBe(false);
    expect(await targets.list(connectionId)).toEqual([{ userId: "u1", memo: "しえるさん" }]);
  });
});

describe("DajarePostRepository", () => {
  it("投稿を記録し、公認は1回だけ確定する", async () => {
    const posts = new DajarePostRepository(db);
    await posts.add(connectionId, "c1", "m1");
    expect(await posts.get("m1")).toMatchObject({
      messageId: "m1",
      channelId: "c1",
      status: "voting",
    });
    expect(await posts.approve("m1")).toBe(true);
    expect(await posts.approve("m1")).toBe(false);
    expect((await posts.get("m1"))?.status).toBe("approved");
  });

  it("記録を消す。連携の投稿を一覧で取り出せる", async () => {
    const posts = new DajarePostRepository(db);
    await posts.add(connectionId, "c1", "m1");
    await posts.add(connectionId, "c1", "m2");
    expect((await posts.listAll(connectionId)).map((p) => p.messageId)).toEqual(["m1", "m2"]);
    expect(await posts.delete("m1")).toBe(true);
    expect(await posts.delete("m1")).toBe(false);
    expect(await posts.get("m1")).toBeNull();
    expect((await posts.listAll(connectionId)).map((p) => p.messageId)).toEqual(["m2"]);
  });

  it("本文・ニックネーム・user.id を入れる列がない", async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'dajare_posts' ORDER BY 1`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "channel_id",
      "connection_id",
      "created_at",
      "message_id",
      "status",
    ]);
  });
});
