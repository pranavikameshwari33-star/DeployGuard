/**
 * Applies the SQL files in db/migrations to the database in DATABASE_URL.
 *
 * Every migration is written to be re-runnable (CREATE TABLE IF NOT EXISTS and
 * friends), so running this twice is harmless. That keeps the setup simple:
 * no migration-history table to understand yet.
 *
 *   npm run db:migrate
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "Add it to .env.local. For Supabase: Project Settings -> Database ->\n" +
      "Connection string -> Transaction pooler."
  );
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);

const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

const dir = path.join(process.cwd(), "db", "migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

try {
  await client.connect();
  console.log(`Connected. Applying ${files.length} migration file(s).`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await client.query(sql);
    console.log(`  applied ${file}`);
  }

  const { rows } = await client.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'deployments'
     ORDER BY ordinal_position`
  );
  console.log("\ndeployments table:");
  for (const row of rows) {
    console.log(`  ${row.column_name.padEnd(16)} ${row.data_type}`);
  }
  console.log("\nMigration complete.");
} catch (error) {
  // Print the database's message, never the connection string (it holds the password).
  console.error(`\nMigration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
