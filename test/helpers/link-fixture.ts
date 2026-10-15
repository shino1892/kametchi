import { randomBytes } from "node:crypto";
import { AppLogRepository } from "../../src/db/app-logs.js";
import { ConnectionRepository } from "../../src/db/connection.js";
import { DajarePostRepository, DajareTargetRepository } from "../../src/db/dajare.js";
import { LinkRepository } from "../../src/db/link.js";
import { TokenCipher } from "../../src/db/token-cipher.js";
import { SpoonLink } from "../../src/link/spoon-link.js";
import { FakeClock } from "./fake-clock.js";
import { setupMock } from "./mock-spoon.js";
import { createTestDatabase } from "./test-db.js";

export const APP_BASE_URL = "http://localhost:8790";

/** モックの Spoon と PGlite を相手にする SpoonLink 一式 */
export async function setupLink() {
  const clock = new FakeClock(Date.parse("2026-10-15T12:00:00Z"));
  const db = await createTestDatabase();
  const spoon = setupMock({ clock });
  const connections = new ConnectionRepository(db, new TokenCipher(randomBytes(32)));
  const dajareTargets = new DajareTargetRepository(db);
  const dajarePosts = new DajarePostRepository(db);
  const logs = new AppLogRepository(db);
  const notifications: string[] = [];
  const deletedMessages: string[] = [];
  const errors: string[] = [];
  /** 削除に失敗させるメッセージ ID */
  const failingDeletes = new Set<string>();

  const link = new SpoonLink({
    connections,
    link: new LinkRepository(db),
    dajareTargets,
    dajarePosts,
    logs,
    oauth: spoon.oauth,
    baseUrl: APP_BASE_URL,
    hooks: {
      notify: async (message) => {
        notifications.push(message);
      },
      deleteDiscordMessage: async (_channelId, messageId) => {
        if (failingDeletes.has(messageId)) throw new Error("discord error");
        deletedMessages.push(messageId);
      },
    },
    clock,
    onError: (_error, context) => errors.push(context),
  });

  /** 招待 URL の末尾のトークン */
  const tokenOf = (url: string) => url.slice(`${APP_BASE_URL}/link/`.length);

  /** 同意画面を通して、コールバックに渡る code と state を受け取る（モックは即座に同意する） */
  async function consent(authorizeUrl: string, params: Record<string, string> = {}) {
    const url = new URL(authorizeUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await spoon.mock.fetch(url.toString(), { redirect: "manual" });
    if (response.status !== 302) throw new Error(`authorize failed: ${await response.text()}`);
    const location = new URL(response.headers.get("location") ?? "");
    return {
      code: location.searchParams.get("code") ?? undefined,
      state: location.searchParams.get("state") ?? undefined,
      error: location.searchParams.get("error") ?? undefined,
    };
  }

  /** /link から連携の完了までを通す */
  async function linkThrough(params: Record<string, string> = {}) {
    const invite = await link.createInvite();
    const started = await link.startAuthorization(tokenOf(invite.url));
    if (!started) throw new Error("invite not usable");
    const callback = await consent(started.authorizeUrl, params);
    return link.completeAuthorization({ ...callback, browserSecret: started.browserSecret });
  }

  return {
    clock,
    db,
    spoon,
    link,
    connections,
    dajareTargets,
    dajarePosts,
    logs,
    notifications,
    deletedMessages,
    failingDeletes,
    errors,
    tokenOf,
    consent,
    linkThrough,
    async close() {
      link.stop();
      await db.close();
    },
  };
}
