import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** Folder with the SQL migrations; copied next to dist/db by `pnpm build`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** Arbitrary constant for pg_advisory_lock so concurrent api replicas migrate one at a time. */
const MIGRATION_LOCK = 0x5374_6d70;

export async function createDb(url: string, opts: { max?: number } = {}): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: "stamper-api",
  });
  pool.on("error", () => {
    /* idle-client errors surface on the next query; do not crash the process */
  });
  const db = drizzle(pool, { schema }) as Db;
  await db.execute(sql`select 1`);
  return db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

/** Apply pending migrations (ROLE=api only). Idempotent and serialised by an advisory lock. */
export async function migrate(db: Db): Promise<void> {
  const client = await db.$client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await drizzleMigrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

/** Number of migrations this build ships (drizzle journal). */
function expectedMigrations(): number {
  const j = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries?: unknown[];
  };
  return j.entries?.length ?? 0;
}

/**
 * The worker never migrates; it waits until the api has applied every migration this build
 * ships (so a rolling upgrade never runs new worker code against an old schema).
 */
export async function waitForSchema(db: Db, timeoutMs: number, pollMs = 500): Promise<void> {
  const want = expectedMigrations();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await db.execute<{ ok: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`,
    );
    let n = 0;
    if (t.rows[0]?.ok) {
      const r = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      n = r.rows[0]?.n ?? 0;
    }
    if (n >= want) return;
    if (Date.now() >= deadline)
      throw new Error(`database schema not ready after ${timeoutMs} ms (${n}/${want} migrations)`);
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

export async function ping(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
