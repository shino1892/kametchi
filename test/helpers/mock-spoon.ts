import { MockSpoon, type MockSpoonOptions } from "../../src/mock/spoon-mock.js";
import { SpoonApi } from "../../src/spoon/api.js";
import { type Clock, systemClock } from "../../src/spoon/clock.js";
import { SpoonHttp } from "../../src/spoon/http.js";
import { REQUIRED_SCOPES, SpoonOAuthClient, type TokenSet } from "../../src/spoon/oauth.js";

export const BASE_URL = "http://mock-spoon.test";
export const REDIRECT_URI = "http://localhost:8790/callback";

/** モックと、それを相手にする本物のクライアント一式 */
export function setupMock(options: Partial<MockSpoonOptions> & { clock?: Clock } = {}) {
  const clock = options.clock ?? systemClock;
  const mock = new MockSpoon({
    clients: [
      {
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUris: [REDIRECT_URI],
        scopes: [...REQUIRED_SCOPES],
      },
    ],
    now: () => clock.now(),
    ...options,
  });
  const oauth = new SpoonOAuthClient({
    baseUrl: BASE_URL,
    authorizeUrl: `${BASE_URL}/jp/oauth/authorize`,
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: REDIRECT_URI,
    fetch: mock.fetch,
    clock,
  });
  const api = new SpoonApi(
    new SpoonHttp({ baseUrl: BASE_URL, fetch: mock.fetch, clock, baseBackoffMs: 1 }),
  );

  /** 同意画面を通して code を受け取る（モックは即座に同意する） */
  async function authorize(
    scopes: readonly string[] = REQUIRED_SCOPES,
    djId?: string,
  ): Promise<{ code: string; state: string | null }> {
    const url = new URL(oauth.authorizeUrl("state-1", scopes));
    if (djId) url.searchParams.set("mock_dj", djId);
    const response = await mock.fetch(url.toString(), { redirect: "manual" });
    if (response.status !== 302) throw new Error(`authorize failed: ${await response.text()}`);
    const location = new URL(response.headers.get("location") ?? "");
    return {
      code: location.searchParams.get("code") ?? "",
      state: location.searchParams.get("state"),
    };
  }

  async function connect(
    scopes: readonly string[] = REQUIRED_SCOPES,
    djId?: string,
  ): Promise<TokenSet> {
    const { code } = await authorize(scopes, djId);
    return oauth.exchangeCode(code);
  }

  return { mock, oauth, api, authorize, connect };
}
