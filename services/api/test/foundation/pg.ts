/**
 * Throwaway Postgres for the foundation DB tests. Uses TEST_DATABASE_URL / DATABASE_URL (an
 * admin URL; a fresh database is created per call) when set, otherwise starts
 * pgvector/pgvector:pg17 as container `stamper-wp06-pg` on a random host port. If neither works
 * the caller skips with `skipReason`.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

const CONTAINER = `stamper-wp06-pg-${process.pid}`;
let adminUrl: string | null = null;
let started = false;
export let skipReason = "";

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      return;
    } catch (e) {
      last = e;
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`postgres not ready: ${String(last)}`);
}

export async function startPg(): Promise<string | null> {
  const given = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (given) {
    adminUrl = given;
    return adminUrl;
  }
  try {
    sh("docker", ["rm", "-f", CONTAINER]);
    sh("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_PASSWORD=stamper",
      "-e",
      "POSTGRES_USER=stamper",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-p",
      "127.0.0.1:0:5432",
      "pgvector/pgvector:pg17",
    ]);
    started = true;
    const port = sh("docker", ["port", CONTAINER, "5432/tcp"]).split("\n")[0]?.split(":").pop();
    adminUrl = `postgres://stamper:stamper@127.0.0.1:${port}/postgres`;
    await waitReady(adminUrl, 60_000);
    return adminUrl;
  } catch (e) {
    skipReason = `no throwaway Postgres (docker pgvector/pgvector:pg17 unavailable): ${String(e).slice(0, 200)}`;
    await stopPg();
    return null;
  }
}

/** Create an empty database and return its URL. */
export async function freshDatabase(): Promise<string> {
  if (!adminUrl) throw new Error("startPg() first");
  const name = `stamper_t_${randomBytes(6).toString("hex")}`;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function stopPg(): Promise<void> {
  if (started) {
    try {
      sh("docker", ["rm", "-f", CONTAINER]);
    } catch {
      /* already gone */
    }
    started = false;
  }
}
