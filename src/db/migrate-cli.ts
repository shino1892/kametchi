import { createPgDatabase } from "./database.js";
import { migrate } from "./migrate.js";

/** pnpm db:migrate — DATABASE_URL のデータベースにマイグレーションを適用する */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const db = createPgDatabase(url);
try {
  const applied = await migrate(db);
  console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "already up to date");
} finally {
  await db.close();
}
