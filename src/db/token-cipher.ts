import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;

/**
 * トークンを AES-256-GCM で暗号化する（仕様書 §4.4）。
 *
 * 保存先の行の ID を追加認証データに使い、暗号文を別の行へ移しても復号できないようにする。
 * 形式: `v1.<iv>.<authTag>.<ciphertext>`（いずれも base64url）
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new RangeError("token encryption key must be 32 bytes");
    this.key = key;
  }

  /** TOKEN_ENCRYPTION_KEY（32バイトの base64）から作る */
  static fromBase64(value: string): TokenCipher {
    return new TokenCipher(Buffer.from(value, "base64"));
  }

  encrypt(plaintext: string, boundTo: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(boundTo, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  }

  decrypt(value: string, boundTo: string): string {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error("unsupported token ciphertext");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(boundTo, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
