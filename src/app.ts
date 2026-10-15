import { ChatSender } from "./chat/chat-sender.js";
import { parseDjCommand } from "./chat/dj-commands.js";
import { HeartCommenter } from "./chat/heart-comment.js";
import { HeartSettings } from "./chat/heart-settings.js";
import type { Config } from "./config.js";
import { DajarePoster } from "./dajare/poster.js";
import { DajareJudge } from "./dajare/shareka.js";
import { DajareTargets } from "./dajare/targets.js";
import { DajareVoting } from "./dajare/voting.js";
import { AppLogRepository } from "./db/app-logs.js";
import { ConnectionRepository } from "./db/connection.js";
import { DajarePostRepository, DajareTargetRepository } from "./db/dajare.js";
import type { Database } from "./db/database.js";
import { LinkRepository } from "./db/link.js";
import { migrate } from "./db/migrate.js";
import { scheduleRetention } from "./db/retention.js";
import { SettingsRepository } from "./db/settings.js";
import { TokenCipher } from "./db/token-cipher.js";
import { DiscordBot } from "./discord/bot.js";
import { ChatRelay } from "./discord/chat-relay.js";
import { DajareChannel } from "./discord/dajare-channel.js";
import { DajareCommands } from "./discord/dajare-commands.js";
import { HeartCommands } from "./discord/heart-commands.js";
import { LinkCommands } from "./discord/link-commands.js";
import { LiveCommands } from "./discord/live-commands.js";
import { SpoonLink } from "./link/spoon-link.js";
import { LiveSession } from "./live/live-session.js";
import { LiveWatcher } from "./live/live-watcher.js";
import { SpoonApi } from "./spoon/api.js";
import { TokenRevokedError } from "./spoon/errors.js";
import { SpoonHttp } from "./spoon/http.js";
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
  const dajareTargetRepository = new DajareTargetRepository(db);
  const dajarePosts = new DajarePostRepository(db);
  const oauth = new SpoonOAuthClient(config.spoon);
  const api = new SpoonApi(
    new SpoonHttp({
      baseUrl: config.spoon.baseUrl,
      // 上限値は非公開のため、残りが少なくなったら記録する
      onRateLimit: (info) => {
        const { dailyRemaining, dailyLimit } = info;
        if (dailyRemaining !== null && dailyLimit !== null && dailyRemaining < dailyLimit * 0.1) {
          logger.info("rate limit is low", { ...info });
        }
      },
    }),
  );
  /** 状態が変わったときの記録。リスナーを特定する情報は入れない */
  const record = (type: string, detail: Record<string, string | number> = {}) => {
    logger.info(type, detail);
    void logs
      .record(type, detail)
      .catch((error: unknown) => onError(error, "failed to record log"));
  };

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
    dajareTargets: dajareTargetRepository,
    dajarePosts,
    logs,
    oauth,
    baseUrl: config.baseUrl,
    hooks: {
      notify: (message) => bot.notify(message),
      deleteDiscordMessage: (channelId, messageId) => bot.deleteMessage(channelId, messageId),
    },
    onError,
  });

  const liveCommands: LiveCommands = new LiveCommands({
    session: {
      join: () => session.join(),
      leave: (reason) => session.leave(reason),
      isJoined: () => session.isJoined(),
      current: () => session.current(),
    },
    watcher: { current: () => watcher.current() },
    isLinked: () => link.isLinked(),
    notify: (message) => bot.notify(message),
  });
  const watcher = new LiveWatcher(api, () => link.tokens(), {
    onLiveStarted: (live) => liveCommands.onLiveStarted(live),
    onLiveEnded: (live) => liveCommands.onLiveEnded(live),
    onFatalError: (error) => {
      if (!(error instanceof TokenRevokedError)) return false;
      // 解除は確認の停止を待つため、ここでは待たない
      void link.handleError(error);
      return true;
    },
    onLog: record,
  });
  // ---- チャットの送信（仕様書 §7） ----
  const sender = new ChatSender(
    {
      send: async (message, signal) => {
        const manager = link.tokens();
        if (!manager) throw new TokenRevokedError("not linked");
        await manager.withAccessToken((token) => api.sendChat(token, message, signal));
      },
      canSend: () => session.isJoined(),
      onUnlinked: (error) => void link.handleError(error),
    },
    { onLog: record },
  );
  const heartSettings = new HeartSettings(new SettingsRepository(db));
  const heartCommenter = new HeartCommenter({
    enabled: () => heartSettings.enabled(),
    send: (message) => sender.send(message),
  });
  const heartCommands = new HeartCommands({
    settings: heartSettings,
    isLinked: () => link.isLinked(),
    notify: (message) => bot.notify(message),
  });
  const chatRelay = new ChatRelay({
    isJoined: () => session.isJoined(),
    send: (message) => sender.send(message),
  });

  // ---- ダジャレ（仕様書 §8） ----
  const judge = new DajareJudge();
  await judge.init().catch((error: unknown) => onError(error, "failed to load dajare dictionary"));
  const dajareTargets = new DajareTargets(dajareTargetRepository);
  const voting = new DajareVoting({
    posts: dajarePosts,
    threshold: config.voteThreshold,
    onLog: record,
  });
  const dajareChannel = new DajareChannel(
    bot.client,
    config.discord.dajareChannelId,
    voting,
    onError,
  );
  const poster = new DajarePoster({
    judge,
    targets: dajareTargets,
    posts: dajarePosts,
    connectionId: () => link.connectionId(),
    post: (nickname, text) => dajareChannel.post(nickname, text),
    deleteMessage: (channelId, messageId) => bot.deleteMessage(channelId, messageId),
    onLog: record,
  });
  const dajareCommands = new DajareCommands({
    targets: dajareTargets,
    isLinked: () => link.isLinked(),
  });

  const session = new LiveSession(api, () => link.tokens(), {
    onEvent: async (event) => {
      if (event.kind === "like") {
        heartCommenter.handle(event);
      } else if (event.isDj) {
        // 推し本人の発言だけをコマンドとして読む（仕様書 §7.4）
        const command = parseDjCommand(event.message);
        if (command) await heartCommands.handleDjCommand(command);
      } else {
        await poster.handleChat(event);
      }
    },
    onLeft: async (reason, live) => {
      // 退室したら、送っていないチャットと、最近チャットした人の一覧を捨てる
      await sender.clear();
      dajareTargets.forgetChatters();
      await liveCommands.onLeft(reason, live);
    },
    onFatalError: (error) => link.handleError(error).then(() => {}),
    onLog: record,
  });
  link.addListener({
    onLinked: async () => {
      await heartSettings.load(link.connectionId());
      await dajareTargets.load(link.connectionId());
      await dajareTargets.load(link.connectionId());
      watcher.start();
      // 参加中なら、新しいトークンで接続し直す
      if (session.isJoined()) session.reconnectNow();
    },
    onUnlinking: async () => {
      await session.leave("unlinked");
      await watcher.stop();
      await heartSettings.load(null);
      await dajareTargets.load(null);
    },
  });

  await link.load();
  await heartSettings.load(link.connectionId());

  const linkCommands = new LinkCommands({ link, notify: (message) => bot.notify(message) });
  bot.onCommand("link", (interaction) => linkCommands.handleLink(interaction));
  bot.onCommand("unlink", (interaction) => linkCommands.handleUnlink(interaction));
  bot.onButton((interaction) => linkCommands.handleButton(interaction));
  bot.onCommand("join", (interaction) => liveCommands.handleJoinCommand(interaction));
  bot.onCommand("leave", (interaction) => liveCommands.handleLeaveCommand(interaction));
  bot.onButton((interaction) => liveCommands.handleButton(interaction));
  bot.onCommand("heart", (interaction) => {
    const state = interaction.option?.("state");
    return heartCommands.handleCommand(
      interaction,
      state === "on" || state === "off" ? state : null,
    );
  });
  bot.onChatMessage((content) => chatRelay.handle(content));
  bot.onCommand("dajare-target", (interaction) => dajareCommands.handleCommand(interaction));
  bot.onAutocomplete("dajare-target", (interaction) =>
    dajareCommands.handleAutocomplete(interaction),
  );
  await bot.start();
  // 起動したときに配信中なら知らせる（Discord の準備ができてから。自動では参加しない）
  if (link.isLinked()) watcher.start();

  const web = createWebApp({
    link,
    baseUrl: config.baseUrl,
    secureCookies: config.secureCookies,
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
      // 終了時は知らせずに退室する（再起動後は退室した状態から始める。仕様書 §6.2）
      await session.leave("manual");
      await watcher.stop();
      link.stop();
      await bot.stop();
      await retention.stop();
    },
  };
}
