import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppLogRepository } from "../../src/db/app-logs.js";
import type { Database } from "../../src/db/database.js";
import { LinkRepository } from "../../src/db/link.js";
import { runRetention } from "../../src/db/retention.js";
import { createTestDatabase } from "../helpers/test-db.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const state = (n: number, browser = "b1") => ({
  stateHash: `s${n}`,
  browserHash: browser,
  expiresAt: minutes(10),
});

let db: Database;
let link: LinkRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  link = new LinkRepository(db);
});
afterEach(() => db.close());

describe("LinkRepository", () => {
  it("招待は期限内で未使用のときだけ使え、1回しか使えない", async () => {
    await link.createInvite("i1", minutes(10));
    expect(await link.isInviteUsable("i1", NOW)).toBe(true);
    expect(await link.useInvite("i1", state(1), NOW)).toBe(true);
    expect(await link.isInviteUsable("i1", NOW)).toBe(false);
    expect(await link.useInvite("i1", state(2), NOW)).toBe(false);
  });

  it("期限切れ・存在しない招待は使えない", async () => {
    await link.createInvite("i1", minutes(10));
    expect(await link.isInviteUsable("i1", minutes(10))).toBe(false);
    expect(await link.useInvite("i1", state(1), minutes(11))).toBe(false);
    expect(await link.useInvite("nope", state(2), NOW)).toBe(false);
    expect(await db.query("SELECT 1 FROM oauth_states")).toEqual([]);
  });

  it("state は同じブラウザ・期限内のときだけ通り、確かめたら消える", async () => {
    await link.createInvite("i1", minutes(10));
    await link.useInvite("i1", state(1), NOW);
    expect(await link.consumeState("s1", "b1", minutes(1))).toBe(true);
    expect(await link.consumeState("s1", "b1", minutes(1))).toBe(false);
  });

  it("別のブラウザや期限切れの state は通さず、試した時点で消す", async () => {
    await link.createInvite("i1", minutes(10));
    await link.createInvite("i2", minutes(10));
    await link.useInvite("i1", state(1), NOW);
    await link.useInvite("i2", state(2), NOW);

    expect(await link.consumeState("s1", "other", minutes(1))).toBe(false);
    expect(await link.consumeState("s1", "b1", minutes(1))).toBe(false);
    expect(await link.consumeState("s2", "b1", minutes(10))).toBe(false);
  });
});

describe("runRetention", () => {
  it("30日を過ぎた記録と、失効した招待・state を削除する", async () => {
    const logs = new AppLogRepository(db);
    await logs.record("old", { count: 1 });
    await logs.record("new");
    await db.query("UPDATE app_logs SET created_at = $1 WHERE type = $2", [
      new Date(NOW.getTime() - 31 * 24 * 3_600_000),
      "old",
    ]);

    await link.createInvite("expired", minutes(-1));
    await link.createInvite("live", minutes(10));
    await link.createInvite("used", minutes(5));
    await link.useInvite("used", { ...state(1), expiresAt: minutes(-1) }, minutes(-5));

    expect(await runRetention(db, NOW)).toEqual({ appLogs: 1, linkInvites: 1, oauthStates: 1 });
    expect((await logs.listRecent()).map((l) => l.type)).toEqual(["new"]);
    const invites = await db.query<{ token_hash: string }>(
      "SELECT token_hash FROM link_invites ORDER BY 1",
    );
    expect(invites.map((i) => i.token_hash)).toEqual(["live", "used"]);
  });
});
