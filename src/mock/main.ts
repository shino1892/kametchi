import { serve } from "@hono/node-server";
import { REQUIRED_SCOPES } from "../spoon/oauth.js";
import { MockSpoon } from "./spoon-mock.js";

/**
 * Spoon Developers API のモックサーバーをローカルで起動する（pnpm mock）。
 * .env の SPOON_BASE_URL と SPOON_AUTHORIZE_URL をこのサーバーに向けて使う。
 */
const port = Number(process.env.MOCK_SPOON_PORT ?? 8788);
const clientId = process.env.SPOON_CLIENT_ID || "mock-client";
const clientSecret = process.env.SPOON_CLIENT_SECRET || "mock-secret";
const redirectUri = process.env.SPOON_REDIRECT_URI || "http://localhost:8790/callback";

const mock = new MockSpoon({
  clients: [{ clientId, clientSecret, redirectUris: [redirectUri], scopes: [...REQUIRED_SCOPES] }],
});

const base = `http://localhost:${port}`;
serve({ fetch: mock.app.fetch, port }, () => {
  console.log(`Mock Spoon API: ${base}`);
  console.log(`  SPOON_BASE_URL=${base}`);
  console.log(`  SPOON_AUTHORIZE_URL=${base}/jp/oauth/authorize`);
  console.log(`  client_id=${clientId} redirect_uri=${redirectUri}`);
  console.log("操作例（日本語を含む本文はファイルに保存して --data-binary @body.json で送る）:");
  console.log(`  curl -X POST ${base}/__mock/start-live`);
  console.log(
    `  curl -X POST ${base}/__mock/like -H "Content-Type: application/json" -d '{"id":"l1","type":"FREE"}'`,
  );
  console.log(
    `  curl -X POST ${base}/__mock/chat -H "Content-Type: application/json" -d '{"id":"l1","message":"hello"}'`,
  );
  console.log(`  curl -X POST ${base}/__mock/end-live`);
});
