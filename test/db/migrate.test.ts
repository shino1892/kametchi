import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { createEmptyTestDatabase } from "../helpers/test-db.js";

describe("migrate", () => {
  it("未適用のマイグレーションを適用し、2回目は何もしない", async () => {
    const db = await createEmptyTestDatabase();
    expect(await migrate(db)).toEqual(["001_initial"]);
    expect(await migrate(db)).toEqual([]);

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "app_logs",
      "dajare_posts",
      "dajare_targets",
      "link_invites",
      "oauth_states",
      "schema_migrations",
      "settings",
      "spoon_connection",
    ]);
    await db.close();
  });

  it("失敗したマイグレーションはロールバックし、適用済みとして記録しない", async () => {
    const db = await createEmptyTestDatabase();
    const dir = new URL("./fixtures/broken-migrations/", import.meta.url);
    await expect(migrate(db, dir)).rejects.toThrow();

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'should_not_exist'",
    );
    expect(tables).toEqual([]);
    expect(await db.query("SELECT * FROM schema_migrations")).toEqual([]);
    await db.close();
  });
});
