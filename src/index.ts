import { serve } from "@hono/node-server";
import { type AppLogger, startApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createPgDatabase } from "./db/database.js";

/** ログには秘密情報・チャット本文・リスナーを特定する情報を出さない（仕様書 §0） */
const logger: AppLogger = {
  info: (message, detail) => console.log(new Date().toISOString(), message, detail ?? ""),
  error: (message, error) =>
    console.error(
      new Date().toISOString(),
      message,
      error instanceof Error ? error.message : (error ?? ""),
    ),
};

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const db = createPgDatabase(config.databaseUrl);
const app = await startApp(config, db, logger);
const server = serve({ fetch: app.web.fetch, port: config.port, hostname: config.host }, () => {
  logger.info(`listening on ${config.baseUrl} (${config.host}:${config.port})`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.stop();
    await db.close();
  } catch (error) {
    logger.error("shutdown failed", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
