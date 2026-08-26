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

    create table if not exists stickers (
      id          serial primary key,
      -- Where it was first seen. Provenance only: the library is shared by every chat.
      chat        text        not null,
      -- Hash of the actual bytes, and the identity of a sticker. The same one gets sent over
      -- and over, and this is what stops it being re-uploaded and re-described every time.
      sha256      text        not null,
      url         text        not null,
      label       text        not null,
      description text,
      added_by    text,
      created_at  timestamptz not null default now()
    );

    -- The sticker itself, so the library survives losing the media host — a new number means a
    -- new session, and nothing guarantees the old upload URLs outlive it.
    alter table stickers add column if not exists bytes bytea;

    /*
     * Stickers used to be scoped per chat, one row per (chat, sha256). They are now shared, so
     * the duplicates collapse to one row each. Guarded on the old constraint so the delete runs
     * exactly once, on the deployment that first sees this code, and never again.
     */
    do $$
    begin
      if exists (
        select 1 from pg_constraint where conname = 'stickers_chat_sha256_key'
      ) then
        delete from stickers a using stickers b
         where a.sha256 = b.sha256 and a.id > b.id;
        alter table stickers drop constraint stickers_chat_sha256_key;
      end if;
    end $$;

    create unique index if not exists stickers_sha256_key on stickers (sha256);

    /*
     * What the bot has spent. Written after every model call — OpenAI's own usage and cost
     * endpoints need an Admin key, which this app does not have and should not need.
     * Named model_usage because "usage" is a keyword in enough contexts to be a nuisance.
     */
    create table if not exists model_usage (
      id             bigserial primary key,
      at             timestamptz not null default now(),
      -- reply | vision | speech
      kind           text        not null,
      model          text        not null,
      input_tokens   integer     not null default 0,
      output_tokens  integer     not null default 0,
      cached_tokens  integer     not null default 0,
      -- Speech is billed on text, not tokens, and the SDK reports no usage for it.
      characters     integer     not null default 0,
      chat           text
    );
    create index if not exists model_usage_at_idx on model_usage (at desc);
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
