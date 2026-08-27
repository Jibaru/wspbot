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

    /*
     * One Notion connection per chat. Keyed on the chat rather than the person because the bot
     * acts on behalf of a conversation: whoever connects it is choosing, at Notion's own consent
     * screen, exactly which pages that room may reach.
     */
    /*
     * Scheduled reminders. One per person per chat, which the primary key enforces rather than
     * any code: setting a second one is an upsert, so "change my reminder" and "create one" are
     * the same operation and cannot drift apart.
     */
    create table if not exists reminders (
      chat          text        not null,
      user_id       text        not null,
      -- What to do when it fires, in the person's own words. Run through the model, so it can
      -- be "remind me to stretch" or "check whether it will rain and tell me".
      prompt        text        not null,
      asked_by      text,
      next_at       timestamptz not null,
      -- null means it fires once and is then removed.
      every_minutes integer,
      max_runs      integer,
      runs          integer     not null default 0,
      created_at    timestamptz not null default now(),
      primary key (chat, user_id)
    );
    -- The due query runs every half minute and almost always returns nothing.
    create index if not exists reminders_next_at_idx on reminders (next_at);

    /*
     * Rate limiting. Two tables: what each person is allowed, and what they have actually done.
     *
     * rate_limits is meant to be edited by hand — there is no tool for it on purpose, since
     * raising your own quota by asking the bot would defeat the point.
     */
    create table if not exists rate_limits (
      user_id    text primary key,
      per_minute integer     not null,
      note       text,
      updated_at timestamptz not null default now()
    );

    create table if not exists bot_calls (
      id      bigserial primary key,
      user_id text        not null,
      chat    text,
      -- 'call' counts against the quota; 'warned' records that we already said so, so a
      -- spammer gets one reply per window rather than one per message.
      kind    text        not null default 'call',
      at      timestamptz not null default now()
    );
    -- The window query runs on every tagged message, so it gets its own index.
    create index if not exists bot_calls_user_at_idx on bot_calls (user_id, kind, at desc);

    /*
     * The chat's checklist. Per chat, like memories: a group's pending list belongs to that
     * group, and one shared list across rooms would be nonsense.
     */
    create table if not exists tasks (
      id         serial primary key,
      chat       text        not null,
      text       text        not null,
      done       boolean     not null default false,
      added_by   text,
      done_by    text,
      created_at timestamptz not null default now(),
      done_at    timestamptz
    );
    -- Open tasks of one chat, in order: the query the prompt makes on every single turn.
    create index if not exists tasks_chat_idx on tasks (chat, done, id);

    /*
     * Which abilities are switched off, set from the dashboard. Only deviations are stored:
     * no row means on, so a feature added in a later release arrives enabled without a
     * migration, and this stays a list of decisions somebody made rather than a mirror of
     * the registry in lib/features.ts.
     */
    create table if not exists features (
      key        text primary key,
      enabled    boolean     not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists notion_connections (
      chat           text primary key,
      access_token   text        not null,
      refresh_token  text,
      workspace_id   text,
      workspace_name text,
      bot_id         text,
      connected_by   text,
      connected_at   timestamptz not null default now()
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
