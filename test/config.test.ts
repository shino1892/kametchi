import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const valid = {
  APP_BASE_URL: "https://kametchi.com",
  DATABASE_URL: "postgres://kametchi:pw@192.168.0.109:5432/kametchi",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SPOON_BASE_URL: "https://jp-openapi.spooncast.net",
  SPOON_AUTHORIZE_URL: "https://developers.spooncast.net/jp/oauth/authorize",
  SPOON_CLIENT_ID: "client",
  SPOON_CLIENT_SECRET: "secret-value",
  SPOON_REDIRECT_URI: "https://kametchi.com/callback",
  DISCORD_BOT_TOKEN: "discord-token-value",
  DISCORD_APP_ID: "123456789012345678",
  DISCORD_GUILD_ID: "223456789012345678",
  DISCORD_MAIN_CHANNEL_ID: "323456789012345678",
  DISCORD_CHAT_CHANNEL_ID: "423456789012345678",
  DISCORD_DAJARE_CHANNEL_ID: "523456789012345678",
  PRIVACY_CONTACT_X: "@example",
};

function problemsOf(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("環境変数から設定を読み込み、既定値を補う", () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(8790);
    expect(config.host).toBe("127.0.0.1");
    expect(config.secureCookies).toBe(true);
    expect(config.voteThreshold).toBe(4);
    expect(config.tokenEncryptionKey).toHaveLength(32);
    expect(config.discord.dajareChannelId).toBe("523456789012345678");
    expect(config.privacy).toEqual({ x: "@example" });
  });

  it("開発中は localhost の http を使え、Cookie に Secure を付けない", () => {
    const config = loadConfig({
      ...valid,
      APP_BASE_URL: "http://localhost:8790/",
      SPOON_REDIRECT_URI: "http://localhost:8790/callback",
    });
    expect(config.baseUrl).toBe("http://localhost:8790");
    expect(config.secureCookies).toBe(false);
  });

  it("localhost 以外の http は受け付けない", () => {
    expect(
      problemsOf({
        ...valid,
        APP_BASE_URL: "http://kametchi.com",
        SPOON_REDIRECT_URI: "http://kametchi.com/callback",
      }),
    ).toContain("APP_BASE_URL must use https");
  });

  it("足りない値をまとめて報告し、値そのものは出さない", () => {
    const message = problemsOf({ ...valid, SPOON_CLIENT_SECRET: "", DISCORD_BOT_TOKEN: " " });
    expect(message).toContain("SPOON_CLIENT_SECRET is not set");
    expect(message).toContain("DISCORD_BOT_TOKEN is not set");
    expect(message).not.toContain("secret-value");
  });

  it("鍵の長さ・Discord の ID・票数を確かめる", () => {
    const message = problemsOf({
      ...valid,
      TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64"),
      DISCORD_CHAT_CHANNEL_ID: "chat",
      VOTE_THRESHOLD: "0",
    });
    expect(message).toContain("TOKEN_ENCRYPTION_KEY must be 32 bytes");
    expect(message).toContain("DISCORD_CHAT_CHANNEL_ID must be a Discord ID");
    expect(message).toContain("VOTE_THRESHOLD must be an integer between 1 and 100");
    expect(message).not.toContain(valid.TOKEN_ENCRYPTION_KEY);
  });

  it("SPOON_REDIRECT_URI は APP_BASE_URL と同じオリジンにする", () => {
    expect(problemsOf({ ...valid, SPOON_REDIRECT_URI: "https://example.com/callback" })).toContain(
      "SPOON_REDIRECT_URI must have the same origin as APP_BASE_URL",
    );
  });

  it("プライバシーポリシーの窓口が必要", () => {
    const { PRIVACY_CONTACT_X: _, ...withoutContact } = valid;
    expect(problemsOf(withoutContact)).toContain("PRIVACY_CONTACT_X or PRIVACY_CONTACT_EMAIL");
    expect(problemsOf({ ...valid, PRIVACY_CONTACT_EMAIL: "not-an-email" })).toContain(
      "PRIVACY_CONTACT_EMAIL is not a valid email address",
    );
  });
});
