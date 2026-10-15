import type { Config } from "./config.js";
import { AppLogRepository } from "./db/app-logs.js";
import { ConnectionRepository } from "./db/connection.js";
import { DajarePostRepository, DajareTargetRepository } from "./db/dajare.js";
import type { Database } from "./db/database.js";
import { LinkRepository } from "./db/link.js";
import { migrate } from "./db/migrate.js";
import { scheduleRetention } from "./db/retention.js";
import { TokenCipher } from "./db/token-cipher.js";
import { DiscordBot } from "./discord/bot.js";
import { LinkCommands } from "./discord/link-commands.js";
import { SpoonLink } from "./link/spoon-link.js";
import { SpoonOAuthClient } from "./spoon/oauth.js";
import { createWebApp } from "./web/web-app.js";

export interface AppLogger {
  info(message: string, detail?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

/**
 * アプリを組み立てて起動する。マイグレーションを適用し、日次の削除、Spoon連携の読み込み、
 * Discord ボットの起動を行う。ウェブ（web）は呼び出し側で配信する。
 */
export async function startApp(config: Config, db: Database, logger: AppLogger) {
  await migrate(db);
  const onError = (error: unknown, context: string) => logger.error(context, error);

  const connections = new ConnectionRepository(db, new TokenCipher(config.tokenEncryptionKey));
  const logs = new AppLogRepository(db);
  const oauth = new SpoonOAuthClient(config.spoon);

  const retention = scheduleRetention(db, {
    onResult: (result) => logger.info("retention completed", { ...result }),
    onError: (error) => logger.error("retention failed", error),
  });

  const bot = new DiscordBot({
    discord: config.discord,
    onError,
    onReady: (tag) => logger.info(`discord ready: ${tag}`),
  });

  const link = new SpoonLink({
    connections,
    link: new LinkRepository(db),
    dajareTargets: new DajareTargetRepository(db),
    dajarePosts: new DajarePostRepository(db),
    logs,
    oauth,
    baseUrl: config.baseUrl,
    hooks: {
      notify: (message) => bot.notify(message),
      deleteDiscordMessage: (channelId, messageId) => bot.deleteMessage(channelId, messageId),
    },
    onError,
  });
  await link.load();

  const linkCommands = new LinkCommands({ link, notify: (message) => bot.notify(message) });
  bot.onCommand("link", (interaction) => linkCommands.handleLink(interaction));
  bot.onCommand("unlink", (interaction) => linkCommands.handleUnlink(interaction));
  bot.onButton((interaction) => linkCommands.handleButton(interaction));
  await bot.start();

  const web = createWebApp({
    link,
    baseUrl: config.baseUrl,
    secureCookies: config.secureCookies,
    spoonAuthorizeUrl: config.spoon.authorizeUrl,
    spoonRedirectUri: config.spoon.redirectUri,
    privacy: config.privacy,
    healthCheck: async () => {
      await db.query("SELECT 1");
    },
    onError,
  });
  logger.info("kametti started", { linked: link.isLinked() });

  return {
    web,
    link,
    async stop() {
      link.stop();
      await bot.stop();
      await retention.stop();
    },
  };
}
