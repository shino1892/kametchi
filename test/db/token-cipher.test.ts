import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher } from "../../src/db/token-cipher.js";

const cipher = new TokenCipher(randomBytes(32));

describe("TokenCipher", () => {
  it("暗号化した値を同じ ID で復号できる", () => {
    const encrypted = cipher.encrypt("rt_7b2e5a9c4f10d386", "conn-1");
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("rt_7b2e5a9c4f10d386");
    expect(cipher.decrypt(encrypted, "conn-1")).toBe("rt_7b2e5a9c4f10d386");
  });

  it("同じ平文でも毎回異なる暗号文になる", () => {
    expect(cipher.encrypt("x", "conn-1")).not.toBe(cipher.encrypt("x", "conn-1"));
  });

  it("別の ID では復号できない（暗号文を別の行に移しても使えない）", () => {
    const encrypted = cipher.encrypt("secret", "conn-1");
    expect(() => cipher.decrypt(encrypted, "conn-2")).toThrow();
  });

  it("改ざんされた暗号文は復号できない", () => {
    const [version, iv, tag, body] = cipher.encrypt("secret", "conn-1").split(".");
    const tampered = Buffer.from(body ?? "", "base64url");
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() =>
      cipher.decrypt([version, iv, tag, tampered.toString("base64url")].join("."), "conn-1"),
    ).toThrow();
  });

  it("別の鍵では復号できない", () => {
    const encrypted = cipher.encrypt("secret", "conn-1");
    expect(() => new TokenCipher(randomBytes(32)).decrypt(encrypted, "conn-1")).toThrow();
  });

  it("32バイト以外の鍵は拒否する", () => {
    expect(() => new TokenCipher(randomBytes(16))).toThrow(RangeError);
    expect(() => TokenCipher.fromBase64(randomBytes(32).toString("base64"))).not.toThrow();
  });
});
