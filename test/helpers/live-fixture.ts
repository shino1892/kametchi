import type { TokenSet } from "../../src/spoon/oauth.js";
import { TokenManager } from "../../src/spoon/token-manager.js";
import { setupMock } from "./mock-spoon.js";

/** 条件が満たされるまで待つ（実時間。モックのストリームは本物のタイマーで動くため） */
export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** モックの Spoon に連携済みの TokenManager */
export async function setupLinkedMock(options: Parameters<typeof setupMock>[0] = {}) {
  const spoon = setupMock(options);
  const initial = await spoon.connect();
  const saved: TokenSet[] = [];
  const manager = new TokenManager(spoon.oauth, initial, {
    save: async (tokens) => void saved.push(tokens),
  });
  return { ...spoon, manager, saved };
}
