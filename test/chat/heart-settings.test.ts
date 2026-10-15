import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeartSettings } from "../../src/chat/heart-settings.js";
import { ConnectionRepository } from "../../src/db/connection.js";
import type { Database } from "../../src/db/database.js";
import { SettingsRepository } from "../../src/db/settings.js";
import { TokenCipher } from "../../src/db/token-cipher.js";
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

describe("HeartSettings", () => {
  it("初期値はオン。変えた値を保存し、読み込み直しても残る", async () => {
    const settings = new HeartSettings(new SettingsRepository(db));
    await settings.load(connectionId);
    expect(settings.enabled()).toBe(true);

    expect(await settings.set(false)).toBe(true);
    expect(settings.enabled()).toBe(false);

    const reloaded = new HeartSettings(new SettingsRepository(db));
    await reloaded.load(connectionId);
    expect(reloaded.enabled()).toBe(false);
  });

  it("連携していなければオフ扱いで、変えられない", async () => {
    const settings = new HeartSettings(new SettingsRepository(db));
    await settings.load(null);
    expect(settings.enabled()).toBe(false);
    expect(await settings.set(true)).toBe(false);
  });
});
