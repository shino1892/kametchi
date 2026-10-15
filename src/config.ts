/** 環境変数から読み込む設定（仕様書 §10、.env.example を参照） */
export interface Config {
  /** 連携用ページの URL。例: https://kametchi.com */
  baseUrl: string;
  /** baseUrl が https か（Cookie に Secure と __Host- を付けるか） */
  secureCookies: boolean;
  port: number;
  /** 待ち受けるアドレス。本番は NPM から届くアドレス */
  host: string;
  databaseUrl: string;
  /** トークン暗号化鍵（32バイト） */
  tokenEncryptionKey: Buffer;
  spoon: {
    baseUrl: string;
    authorizeUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  discord: {
    botToken: string;
    appId: string;
    guildId: string;
    mainChannelId: string;
    chatChannelId: string;
    dajareChannelId: string;
  };
  /** ダジャレの投票で確定する票数（仕様書 §8.3） */
  voteThreshold: number;
  /** プライバシーポリシーに載せる窓口 */
  privacy: { x?: string; email?: string };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** 開発中に http を使ってよいホスト */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Discord の ID（snowflake） */
const SNOWFLAKE = /^\d{17,20}$/;

/** 設定を読み込む。足りない・不正な値はまとめて ConfigError にする（値そのものは出さない） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string): string => {
    const value = optional(name);
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };
  const url = (name: string): string => {
    const value = required(name);
    if (value && !URL.canParse(value)) problems.push(`${name} is not a valid URL`);
    return value;
  };
  const snowflake = (name: string): string => {
    const value = required(name);
    if (value && !SNOWFLAKE.test(value)) problems.push(`${name} must be a Discord ID`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number(optional(name) ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  };

  const baseUrl = url("APP_BASE_URL").replace(/\/+$/, "");
  const base = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
  if (base && base.protocol !== "https:" && !LOCAL_HOSTS.has(base.hostname)) {
    problems.push("APP_BASE_URL must use https (http is allowed only for localhost)");
  }

  const keyText = required("TOKEN_ENCRYPTION_KEY");
  const tokenEncryptionKey = Buffer.from(keyText, "base64");
  if (keyText && tokenEncryptionKey.length !== 32) {
    problems.push("TOKEN_ENCRYPTION_KEY must be 32 bytes encoded in base64");
  }

  const privacy: Config["privacy"] = {};
  const contactX = optional("PRIVACY_CONTACT_X");
  const contactEmail = optional("PRIVACY_CONTACT_EMAIL");
  if (contactX) privacy.x = contactX;
  if (contactEmail) privacy.email = contactEmail;
  if (!contactX && !contactEmail) {
    problems.push("PRIVACY_CONTACT_X or PRIVACY_CONTACT_EMAIL must be set");
  }
  if (contactX && !/^@?[A-Za-z0-9_]{1,15}$/.test(contactX)) {
    problems.push("PRIVACY_CONTACT_X must be an X account name such as @example");
  }
  if (contactEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contactEmail)) {
    problems.push("PRIVACY_CONTACT_EMAIL is not a valid email address");
  }

  const config: Config = {
    baseUrl,
    secureCookies: base?.protocol === "https:",
    port: integer("PORT", 8790, 1, 65535),
    host: optional("HOST") ?? "127.0.0.1",
    databaseUrl: url("DATABASE_URL"),
    tokenEncryptionKey,
    spoon: {
      baseUrl: url("SPOON_BASE_URL"),
      authorizeUrl: url("SPOON_AUTHORIZE_URL"),
      clientId: required("SPOON_CLIENT_ID"),
      clientSecret: required("SPOON_CLIENT_SECRET"),
      redirectUri: url("SPOON_REDIRECT_URI"),
    },
    discord: {
      botToken: required("DISCORD_BOT_TOKEN"),
      appId: snowflake("DISCORD_APP_ID"),
      guildId: snowflake("DISCORD_GUILD_ID"),
      mainChannelId: snowflake("DISCORD_MAIN_CHANNEL_ID"),
      chatChannelId: snowflake("DISCORD_CHAT_CHANNEL_ID"),
      dajareChannelId: snowflake("DISCORD_DAJARE_CHANNEL_ID"),
    },
    voteThreshold: integer("VOTE_THRESHOLD", 4, 1, 100),
    privacy,
  };

  // コールバックは連携用ページと同じオリジンで受ける（Cookie の state と結びつけるため）
  const redirect = env.SPOON_REDIRECT_URI?.trim();
  if (base && redirect && URL.canParse(redirect) && new URL(redirect).origin !== base.origin) {
    problems.push("SPOON_REDIRECT_URI must have the same origin as APP_BASE_URL");
  }

  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration:\n- ${problems.join("\n- ")}`);
  }
  return config;
}
