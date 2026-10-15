import { describe, expect, it } from "vitest";
import { SpoonApiError, SpoonOAuthError, TokenRevokedError } from "../../src/spoon/errors.js";
import type { TokenSet } from "../../src/spoon/oauth.js";
import { TokenManager } from "../../src/spoon/token-manager.js";
import { FakeClock } from "../helpers/fake-clock.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const SCOPES = ["live.read", "events.chat", "events.like"];

function tokenSet(n: number, expiresAt: number, scopes = SCOPES): TokenSet {
  return { accessToken: `at_${n}`, refreshToken: `rt_${n}`, expiresAt, scopes };
}

/** 呼ばれるたびに番号を進めた新しいトークンを返す OAuth のスタブ */
function fakeOAuth(clock: FakeClock, scopesAfter = SCOPES) {
  let issued = 1;
  const calls: string[] = [];
  return {
    calls,
    oauth: {
      async refresh(refreshToken: string): Promise<TokenSet> {
        calls.push(refreshToken);
        issued += 1;
        return tokenSet(issued, clock.now() + HOUR, scopesAfter);
      },
    },
  };
}

function savedTokens() {
  const saved: TokenSet[] = [];
  return { saved, persistence: { save: async (tokens: TokenSet) => void saved.push(tokens) } };
}

const unauthorized = () => new SpoonApiError(401, null, "Unauthorized");

describe("TokenManager", () => {
  it("失効まで5分以上あれば更新しない", async () => {
    const clock = new FakeClock(0);
    const { oauth, calls } = fakeOAuth(clock);
    const manager = new TokenManager(oauth, tokenSet(1, HOUR), savedTokens().persistence, {
      clock,
    });

    clock.advance(HOUR - 5 * MIN - 1);
    expect(await manager.accessToken()).toBe("at_1");
    expect(calls).toEqual([]);
  });

  it("失効の5分前を過ぎたら更新し、新しいトークンを保存してから返す", async () => {
    const clock = new FakeClock(0);
    const { oauth, calls } = fakeOAuth(clock);
    const { saved, persistence } = savedTokens();
    const manager = new TokenManager(oauth, tokenSet(1, HOUR), persistence, { clock });

    clock.advance(HOUR - 5 * MIN);
    expect(await manager.accessToken()).toBe("at_2");
    expect(calls).toEqual(["rt_1"]);
    expect(saved.map((t) => t.refreshToken)).toEqual(["rt_2"]);

    // 次の更新では新しい Refresh Token を使う
    clock.advance(HOUR);
    await manager.accessToken();
    expect(calls).toEqual(["rt_1", "rt_2"]);
  });

  it("同時に呼ばれても更新は1回だけ行う", async () => {
    const clock = new FakeClock(0);
    const { oauth, calls } = fakeOAuth(clock);
    const manager = new TokenManager(oauth, tokenSet(1, 0), savedTokens().persistence, { clock });

    const tokens = await Promise.all([
      manager.accessToken(),
      manager.accessToken(),
      manager.refresh(),
    ]);
    expect(calls).toEqual(["rt_1"]);
    expect(tokens.slice(0, 2)).toEqual(["at_2", "at_2"]);
  });

  it("invalid_grant なら連携解除として TokenRevokedError を投げる", async () => {
    const oauth = {
      refresh: async (): Promise<TokenSet> => {
        throw new SpoonOAuthError(400, "invalid_grant", "refresh token expired");
      },
    };
    const manager = new TokenManager(oauth, tokenSet(1, 0), savedTokens().persistence, {
      clock: new FakeClock(0),
    });
    await expect(manager.accessToken()).rejects.toBeInstanceOf(TokenRevokedError);
  });

  it("invalid_grant 以外の更新失敗はそのまま投げ、次の呼び出しで再試行する", async () => {
    const clock = new FakeClock(0);
    let fail = true;
    const oauth = {
      refresh: async (): Promise<TokenSet> => {
        if (fail) throw new TypeError("fetch failed");
        return tokenSet(2, HOUR);
      },
    };
    const manager = new TokenManager(oauth, tokenSet(1, 0), savedTokens().persistence, { clock });

    await expect(manager.accessToken()).rejects.toThrow("fetch failed");
    fail = false;
    expect(await manager.accessToken()).toBe("at_2");
  });

  it("権限が減ったら通知する", async () => {
    const clock = new FakeClock(0);
    const { oauth } = fakeOAuth(clock, ["live.read"]);
    const removed: string[][] = [];
    const manager = new TokenManager(oauth, tokenSet(1, 0), savedTokens().persistence, {
      clock,
      onScopesReduced: (scopes) => removed.push(scopes),
    });

    await manager.accessToken();
    expect(removed).toEqual([["events.chat", "events.like"]]);
    expect(manager.hasScope("events.chat")).toBe(false);
  });

  it("保存に失敗してもメモリ上は新しいトークンを使い続ける", async () => {
    const clock = new FakeClock(0);
    const { oauth, calls } = fakeOAuth(clock);
    let failSave = true;
    const persistence = {
      save: async () => {
        if (failSave) throw new Error("db down");
      },
    };
    const manager = new TokenManager(oauth, tokenSet(1, 0), persistence, { clock });

    await expect(manager.accessToken()).rejects.toThrow("db down");
    failSave = false;
    expect(await manager.accessToken()).toBe("at_2");
    expect(calls).toEqual(["rt_1"]);
  });

  describe("withAccessToken", () => {
    it("401 なら一度だけ更新して再試行する", async () => {
      const clock = new FakeClock(0);
      const { oauth, calls } = fakeOAuth(clock);
      const manager = new TokenManager(oauth, tokenSet(1, HOUR), savedTokens().persistence, {
        clock,
      });
      const used: string[] = [];

      const result = await manager.withAccessToken(async (token) => {
        used.push(token);
        if (token === "at_1") throw unauthorized();
        return "ok";
      });

      expect(result).toBe("ok");
      expect(used).toEqual(["at_1", "at_2"]);
      expect(calls).toEqual(["rt_1"]);
    });

    it("更新後も 401 なら TokenRevokedError を投げる", async () => {
      const clock = new FakeClock(0);
      const { oauth } = fakeOAuth(clock);
      const manager = new TokenManager(oauth, tokenSet(1, HOUR), savedTokens().persistence, {
        clock,
      });
      await expect(
        manager.withAccessToken(async () => {
          throw unauthorized();
        }),
      ).rejects.toBeInstanceOf(TokenRevokedError);
    });

    it("401 以外のエラーは更新せずにそのまま投げる", async () => {
      const clock = new FakeClock(0);
      const { oauth, calls } = fakeOAuth(clock);
      const manager = new TokenManager(oauth, tokenSet(1, HOUR), savedTokens().persistence, {
        clock,
      });
      await expect(
        manager.withAccessToken(async () => {
          throw new SpoonApiError(403, null, "Forbidden");
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(calls).toEqual([]);
    });
  });
});
