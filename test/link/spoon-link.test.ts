import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINK_TTL_MS } from "../../src/link/spoon-link.js";
import { TokenRevokedError } from "../../src/spoon/errors.js";
import { REQUIRED_SCOPES } from "../../src/spoon/oauth.js";
import { setupLink } from "../helpers/link-fixture.js";

let t: Awaited<ReturnType<typeof setupLink>>;

beforeEach(async () => {
  t = await setupLink();
});
afterEach(() => t.close());

describe("SpoonLink 連携", () => {
  it("招待から同意・コールバックまでで連携し、トークンを保存して Discord に知らせる", async () => {
    expect(t.link.isLinked()).toBe(false);
    const result = await t.linkThrough();

    expect(result).toEqual({ kind: "linked", relinked: false, missingScopes: [] });
    expect(t.link.isLinked()).toBe(true);
    const connection = await t.connections.get();
    expect(connection?.scopes).toEqual([...REQUIRED_SCOPES]);
    expect(t.notifications.at(-1)).toContain("Spoonと連携しました");

    // 保存したトークンで公式 API を呼べる
    t.spoon.mock.startLive();
    const manager = t.link.tokens();
    await expect(
      manager?.withAccessToken((token) => t.spoon.api.getLive(token)),
    ).resolves.toMatchObject({ title: "テスト配信" });
  });

  it("招待の URL は連携用ページを指し、トークンは推測できない長さで、10分で失効する", async () => {
    const invite = await t.link.createInvite();
    expect(invite.url).toMatch(/^http:\/\/localhost:8790\/link\/[A-Za-z0-9_-]{43}$/);
    expect(invite.expiresAt.getTime() - t.clock.now()).toBe(LINK_TTL_MS);
  });

  it("案内のページを開いただけでは招待を使わない（リンクプレビュー対策）", async () => {
    const invite = await t.link.createInvite();
    const token = t.tokenOf(invite.url);
    expect(await t.link.isInviteUsable(token)).toBe(true);
    expect(await t.link.isInviteUsable(token)).toBe(true);
    expect(await t.link.startAuthorization(token)).not.toBeNull();
    expect(await t.link.isInviteUsable(token)).toBe(false);
    expect(await t.link.startAuthorization(token)).toBeNull();
  });

  it("10分を過ぎた招待は使えない", async () => {
    const invite = await t.link.createInvite();
    t.clock.advance(LINK_TTL_MS);
    expect(await t.link.startAuthorization(t.tokenOf(invite.url))).toBeNull();
  });

  it("形式の違うトークンは DB を見ずに拒否する", async () => {
    expect(await t.link.isInviteUsable("../../etc")).toBe(false);
    expect(await t.link.startAuthorization("short")).toBeNull();
  });

  it("別のブラウザ（Cookie が違う）で戻ってきたら連携しない", async () => {
    const invite = await t.link.createInvite();
    const started = await t.link.startAuthorization(t.tokenOf(invite.url));
    if (!started) throw new Error("not started");
    const callback = await t.consent(started.authorizeUrl);

    const other = await t.link.startAuthorization(t.tokenOf((await t.link.createInvite()).url));
    expect(
      await t.link.completeAuthorization({ ...callback, browserSecret: other?.browserSecret }),
    ).toEqual({ kind: "invalid" });
    // 同じ state は2回目も使えない
    expect(
      await t.link.completeAuthorization({ ...callback, browserSecret: started.browserSecret }),
    ).toEqual({ kind: "invalid" });
    expect(t.link.isLinked()).toBe(false);
  });

  it("Cookie がなければ連携しない", async () => {
    const invite = await t.link.createInvite();
    const started = await t.link.startAuthorization(t.tokenOf(invite.url));
    if (!started) throw new Error("not started");
    const callback = await t.consent(started.authorizeUrl);
    expect(await t.link.completeAuthorization(callback)).toEqual({ kind: "invalid" });
  });

  it("同意しなかったら連携しない", async () => {
    expect(await t.linkThrough({ mock_deny: "1" })).toEqual({ kind: "denied" });
    expect(t.link.isLinked()).toBe(false);
  });

  it("live.read が許可されなければ連携せず、発行されたトークンは無効にする", async () => {
    const result = await t.linkThrough({ scope: "events.chat events.like" });
    expect(result).toEqual({
      kind: "insufficient",
      missingScopes: ["live.read", "chat.send"],
    });
    expect(t.link.isLinked()).toBe(false);
    expect(await t.connections.get()).toBeNull();
    expect(t.spoon.mock.activeGrants()).toBe(0);
    expect(t.notifications.at(-1)).toContain("連携しませんでした");
  });

  it("一部の権限が足りなければ連携し、使えない機能を Discord で知らせる", async () => {
    const result = await t.linkThrough({ scope: "live.read events.chat events.like" });
    expect(result).toEqual({ kind: "linked", relinked: false, missingScopes: ["chat.send"] });
    expect(t.notifications.at(-1)).toContain("chat.send");
  });

  it("連携し直すと新しいトークンに置き換え、連携は1件のまま", async () => {
    await t.linkThrough();
    const first = await t.connections.get();
    expect(await t.linkThrough()).toMatchObject({ kind: "linked", relinked: true });
    expect((await t.connections.get())?.id).toBe(first?.id);
    expect(await t.db.query("SELECT 1 FROM spoon_connection")).toHaveLength(1);
    expect(t.notifications.at(-1)).toContain("連携し直しました");
  });

  it("連携し直したら、登録しておいた処理（配信への再接続など）を呼ぶ", async () => {
    const calls: string[] = [];
    t.link.addListener({ onLinked: () => void calls.push("linked") });
    await t.linkThrough();
    await t.linkThrough();
    expect(calls).toEqual(["linked", "linked"]);
  });

  it("起動時に保存済みの連携を読み込む", async () => {
    await t.linkThrough();
    t.link.stop();
    const { SpoonLink } = await import("../../src/link/spoon-link.js");
    const reloaded = new SpoonLink({
      connections: t.connections,
      link: new (await import("../../src/db/link.js")).LinkRepository(t.db),
      dajareTargets: t.dajareTargets,
      dajarePosts: t.dajarePosts,
      logs: t.logs,
      oauth: t.spoon.oauth,
      baseUrl: "http://localhost:8790",
      hooks: { notify: async () => {}, deleteDiscordMessage: async () => {} },
      clock: t.clock,
    });
    await reloaded.load();
    expect(reloaded.isLinked()).toBe(true);
    reloaded.stop();
  });

  it("連携の操作では、チャット本文やトークンを動作の記録に残さない", async () => {
    await t.linkThrough();
    const logs = JSON.stringify(await t.logs.listRecent());
    const tokens = await t.connections.loadTokens((await t.connections.get())?.id ?? "");
    expect(logs).not.toContain(tokens.accessToken);
    expect(logs).not.toContain(tokens.refreshToken);
  });
});

describe("SpoonLink 解除", () => {
  async function linkWithData() {
    await t.linkThrough();
    const id = (await t.connections.get())?.id ?? "";
    await t.dajareTargets.add(id, { userId: "u1", memo: "しえる" });
    await t.dajarePosts.add(id, "c1", "m1");
    await t.dajarePosts.add(id, "c1", "m2");
    return id;
  }

  it("解除の前に、削除するものの件数を返す", async () => {
    expect(await t.link.unlinkPreview()).toBeNull();
    await linkWithData();
    expect(await t.link.unlinkPreview()).toEqual({ targets: 1, posts: 2 });
  });

  it("手動の解除では、トークンを無効にし、Discord の投稿と DB のデータを削除する", async () => {
    await linkWithData();
    const order: string[] = [];
    t.link.addListener({ onUnlinking: () => void order.push("left the live") });

    const result = await t.link.unlink("manual");
    expect(result).toEqual({ reason: "manual", deletedPosts: 2, failedPosts: 0 });
    expect(order).toEqual(["left the live"]);
    expect(t.spoon.mock.activeGrants()).toBe(0);
    expect(t.deletedMessages).toEqual(["m1", "m2"]);
    for (const table of ["spoon_connection", "settings", "dajare_targets", "dajare_posts"]) {
      expect(await t.db.query(`SELECT 1 FROM ${table}`)).toEqual([]);
    }
    expect(t.link.isLinked()).toBe(false);
    expect(t.link.tokens()).toBeNull();
    expect(t.notifications.at(-1)).toContain("解除しました");
  });

  it("Discord から消せなかった投稿があっても解除を終え、件数を知らせる", async () => {
    await linkWithData();
    t.failingDeletes.add("m2");
    expect(await t.link.unlink("manual")).toEqual({
      reason: "manual",
      deletedPosts: 1,
      failedPosts: 1,
    });
    expect(await t.connections.get()).toBeNull();
    expect(t.notifications.at(-1)).toContain("削除できなかった投稿が 1件");
  });

  it("トークンを無効にできなくても、データは削除する", async () => {
    await linkWithData();
    t.spoon.mock.failNext("POST", "/v1/oauth/revoke", 500);
    await t.link.unlink("manual");
    expect(await t.connections.get()).toBeNull();
    expect(t.errors).toContain("revoke failed");
  });

  it("連携していなければ何もしない。同時に呼ばれても解除は1回", async () => {
    expect(await t.link.unlink("manual")).toBeNull();
    await linkWithData();
    const [a, b] = await Promise.all([t.link.unlink("manual"), t.link.unlink("manual")]);
    expect(a).toEqual(b);
    expect(t.deletedMessages).toEqual(["m1", "m2"]);
  });

  it("Spoon 側で連携が解除されていたら（invalid_grant）、データを削除して知らせる", async () => {
    await linkWithData();
    t.spoon.mock.revokeDj("dj-1");
    const manager = t.link.tokens();
    const error = await manager?.refresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenRevokedError);

    expect(await t.link.handleError(error)).toBe(true);
    expect(await t.connections.get()).toBeNull();
    expect(t.deletedMessages).toEqual(["m1", "m2"]);
    expect(t.notifications.at(-1)).toContain("Spoon 側で連携が解除されていた");
  });

  it("連携の解除以外のエラーでは何もしない", async () => {
    await linkWithData();
    expect(await t.link.handleError(new Error("network"))).toBe(false);
    expect(t.link.isLinked()).toBe(true);
  });
});
