import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionRepository } from "../../src/db/connection.js";
import { DajarePostRepository, DajareTargetRepository } from "../../src/db/dajare.js";
import type { Database } from "../../src/db/database.js";
import { SettingsRepository } from "../../src/db/settings.js";
import { TokenCipher } from "../../src/db/token-cipher.js";
import type { TokenSet } from "../../src/spoon/oauth.js";
import { createTestDatabase } from "../helpers/test-db.js";

const EXPIRES = Date.parse("2026-10-15T13:00:00Z");
const tokens = (n: number, scopes = ["live.read", "events.chat"]): TokenSet => ({
  accessToken: `at_${n}`,
  refreshToken: `rt_${n}`,
  expiresAt: EXPIRES + n,
  scopes,
});

let db: Database;
let connections: ConnectionRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  connections = new ConnectionRepository(db, new TokenCipher(randomBytes(32)));
});
afterEach(() => db.close());

describe("ConnectionRepository", () => {
  it("連携していなければ null", async () => {
    expect(await connections.get()).toBeNull();
  });

  it("トークンを暗号化して保存し、復号して読み出す", async () => {
    const connection = await connections.save(tokens(1));
    expect(connection.scopes).toEqual(["live.read", "events.chat"]);
    expect(await connections.loadTokens(connection.id)).toEqual(tokens(1));

    const [raw] = await db.query<Record<string, unknown>>(
      "SELECT access_token_enc, refresh_token_enc FROM spoon_connection",
    );
    expect(JSON.stringify(raw)).not.toContain("at_1");
    expect(JSON.stringify(raw)).not.toContain("rt_1");
  });

  it("連携し直すとトークンを入れ替え、ID と配下のデータは引き継ぐ（連携は1件だけ）", async () => {
    const first = await connections.save(tokens(1));
    await new SettingsRepository(db).update(first.id, { heartComment: false });

    const second = await connections.save(tokens(2, ["live.read"]));
    expect(second.id).toBe(first.id);
    expect(second.scopes).toEqual(["live.read"]);
    expect(await connections.loadTokens(first.id)).toEqual(tokens(2, ["live.read"]));
    expect(await new SettingsRepository(db).get(first.id)).toEqual({ heartComment: false });
    expect(await db.query("SELECT 1 FROM spoon_connection")).toHaveLength(1);
  });

  it("更新後のトークンを保存する", async () => {
    const connection = await connections.save(tokens(1));
    await connections.persistence(connection.id).save(tokens(3));
    expect(await connections.loadTokens(connection.id)).toEqual(tokens(3));
  });

  it("別の鍵では復号できない", async () => {
    const connection = await connections.save(tokens(1));
    const other = new ConnectionRepository(db, new TokenCipher(randomBytes(32)));
    await expect(other.loadTokens(connection.id)).rejects.toThrow();
  });

  it("削除すると設定・判定対象・投稿の記録もすべて消える", async () => {
    const connection = await connections.save(tokens(1));
    await new SettingsRepository(db).update(connection.id, { heartComment: false });
    await new DajareTargetRepository(db).add(connection.id, { userId: "u1", memo: "しえる" });
    await new DajarePostRepository(db).add(connection.id, "c1", "m1");

    await connections.delete(connection.id);
    for (const table of ["spoon_connection", "settings", "dajare_targets", "dajare_posts"]) {
      expect(await db.query(`SELECT 1 FROM ${table}`)).toEqual([]);
    }
  });
});
