import "server-only";
import { Pool } from "pg";
import { config } from "./config";

/**
 * Postgres, because the bot's memory has to outlive the request that wrote it.
 *
 * A file or an in-process Map would work on a laptop and then quietly lose everything the first
 * time this is deployed — serverless handlers do not share memory, and their filesystem is
 * thrown away. Memory is the feature; it gets real storage.
 */

/**
 * Cached on `globalThis` so hot reloads in dev do not open a new pool per edit until the
 * database refuses connections.
 */
const globalForPool = globalThis as unknown as { wspbotPool?: Pool };

/**
 * `sslmode=require` means different things to libpq and to `pg` 8.23+: libpq encrypts without
 * verifying the certificate, `pg` also verifies it. Managed Postgres commonly presents a
 * self-signed cert, so a connection string that works everywhere else fails here with
 * `DEPTH_ZERO_SELF_SIGNED_CERT`. Opting into libpq's meaning restores it.
 *
 * Only `require` and `prefer` are rewritten — a URL asking for `verify-ca` or `verify-full`
 * means it, and a URL with no `sslmode` is left plain so local Postgres still connects.
 */
const connectionString = (): string => {
  const url = new URL(config.databaseUrl());
  const mode = url.searchParams.get("sslmode");
  if (mode === "require" || mode === "prefer") {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
};

const pool = (): Pool =>
  (globalForPool.wspbotPool ??= new Pool({
    connectionString: connectionString(),
    max: 5,
  }));

/**
 * Schema creation runs once per process, and every statement is idempotent — enough for a
 * three-table app, and it means deploying is just pointing at a database.
 */
const migrate = async (): Promise<void> => {
  await pool().query(`
    create table if not exists memories (
      id         serial primary key,
      chat       text        not null,
      text       text        not null,
      author     text,
      created_at timestamptz not null default now()
    );
    create index if not exists memories_chat_idx on memories (chat);

    create table if not exists messages (
      id         bigserial primary key,
      chat       text        not null,
      role       text        not null,
      content    text        not null,
      created_at timestamptz not null default now()
    );
    create index if not exists messages_chat_idx on messages (chat, id desc);

    create table if not exists seen_messages (
      id         text primary key,
      created_at timestamptz not null default now()
    );
  `);
};

const globalForReady = globalThis as unknown as { wspbotReady?: Promise<void> };

/**
 * Memoised, but only on success. Caching a rejected promise would turn one unreachable-database
 * moment into a permanently broken process, since every later query awaits the same rejection.
 */
const ready = (): Promise<void> =>
  (globalForReady.wspbotReady ??= migrate().catch((err) => {
    delete globalForReady.wspbotReady;
    delete globalForPool.wspbotPool;
    throw err;
  }));

export const query = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> => {
  await ready();
  const result = await pool().query<T>(text, values);
  return result.rows;
};
