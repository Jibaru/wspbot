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
     * Scheduled summaries: read one group, post a digest into another on a cron.
     *
     * Not keyed on the source, so one group can have both a daily and a weekly digest. Each row
     * carries its own watermark, so two schedules over the same group summarise their own
     * windows rather than stealing each other's messages.
     */
    create table if not exists summary_schedules (
      id               serial primary key,
      source_chat      text        not null,
      source_name      text,
      destination_chat text        not null,
      destination_name text,
      -- Five-field cron, evaluated in BOT_TIMEZONE. See lib/cron.ts.
      cron             text        not null,
      enabled          boolean     not null default true,
      -- Everything after this has not been summarised yet. Moved forward only on success, so a
      -- failed run is retried at the next firing rather than silently skipping a day.
      summarised_to    timestamptz,
      -- The wall-clock minute this last fired, which is what stops a restart firing it twice.
      last_minute      text,
      last_run_at      timestamptz,
      last_error       text,
      created_at       timestamptz not null default now()
    );
    create index if not exists summary_schedules_source_idx
      on summary_schedules (source_chat) where enabled;

    /*
     * Every message in a group being summarised — not just the ones tagging the bot. Written
     * only for chats that are the source of an enabled schedule, and pruned on a timer.
     *
     * media_note is what an image actually showed, described once when it arrived. It cannot
     * be done later: the decrypted URL dies after an hour, and a daily digest runs long after
     * that. media_url is a re-upload, which does not expire, so a summary can still attach it.
     */
    create table if not exists logged_messages (
      id          bigserial primary key,
      chat        text        not null,
      message_id  text        not null,
      sender      text,
      sender_name text,
      at          timestamptz not null default now(),
      -- text | image | video | audio | document | sticker | poll
      kind        text        not null default 'text',
      text        text        not null default '',
      media_note  text,
      media_url   text,
      urls        text[]      not null default '{}',
      created_at  timestamptz not null default now()
    );
    create index if not exists logged_messages_chat_at_idx on logged_messages (chat, at);

    /*
     * Chiming in: which groups the bot may speak in without being tagged, and how restrained it
     * has to be about it. Enabling a chat here records it exactly as a summary schedule does —
     * the two read the same logged_messages — so the recording gate has to consult both.
     *
     * last_chime_at is the claim, moved when a run starts rather than when it finishes: a row
     * left due while it is being worked on fires twice the moment a run outlasts the tick.
     * chimed_to is the watermark, moved only once something has actually been considered.
     */
    create table if not exists chime_settings (
      chat          text primary key,
      chat_name     text,
      enabled       boolean     not null default true,
      -- The floor on how often it may speak, and how much has to have been said first.
      every_minutes integer     not null default 90,
      min_messages  integer     not null default 8,
      -- Local hours in BOT_TIMEZONE, "from" inclusive and "to" exclusive; equal means never.
      quiet_from    integer     not null default 23,
      quiet_to      integer     not null default 8,
      max_per_day   integer     not null default 4,
      -- A steer for this group in particular, read into the turn that writes the message.
      note          text,
      chimed_to     timestamptz,
      last_chime_at timestamptz,
      last_error    text,
      created_at    timestamptz not null default now()
    );

    /*
     * What it said unprompted, and on which local day. The day is stored rather than derived,
     * because the cap is "four times today" as a person in Lima reads it, and deriving that from
     * a timestamp in SQL means putting a timezone into every query that counts.
     */
    create table if not exists chimes (
      id   bigserial primary key,
      chat text        not null,
      day  text        not null,
      text text        not null default '',
      at   timestamptz not null default now()
    );
    create index if not exists chimes_chat_day_idx on chimes (chat, day);

    /*
     * GitHub, as one account this deployment acts as. One row, always id 1: two rows would mean
     * every call site had to answer "which account?" for no gain.
     *
     * The token is sealed with AES-256-GCM keyed off AUTH_SECRET (lib/secret-box.ts) rather than
     * stored as text. It is the one credential here that can create repositories on an account,
     * and it is never read back by a person — the dashboard shows four characters — so there is
     * no cost to it being unreadable in a dump of this table.
     */
    create table if not exists github_settings (
      id                 integer primary key default 1 check (id = 1),
      token              text,
      login              text,
      scopes             text,
      hint               text,
      owner              text,
      -- Reads need none of these. Every write is off until somebody turns it on deliberately.
      can_open_issues    boolean     not null default false,
      can_comment        boolean     not null default false,
      can_create_repos   boolean     not null default false,
      repos_private      boolean     not null default true,
      max_writes_per_day integer     not null default 10,
      connected_at       timestamptz
    );

    /*
     * Which repositories may be written to. Empty means none, which is the right state for a
     * token that has just been added: anyone in a group can ask the bot to open an issue, so the
     * list is what decides where that can land. Reads are not gated on it.
     */
    create table if not exists github_repos (
      repo     text primary key,
      added_at timestamptz not null default now()
    );

    /*
     * Everything written to GitHub, kept. It is the daily cap's counter and the answer to "who
     * asked for this issue?", which is the first question anybody would have.
     */
    create table if not exists github_actions (
      id     bigserial primary key,
      at     timestamptz not null default now(),
      chat   text,
      who    text,
      action text        not null,
      target text,
      detail text
    );
    create index if not exists github_actions_at_idx on github_actions (at desc);

    /*
     * Which chats GitHub is reachable from. 'everywhere' is the default so that turning the
     * feature on does not silently do nothing; 'listed' means these rows and nothing else.
     *
     * Added by ALTER rather than in the create above, because the table already exists in a
     * deployment that predates this column, and "create table if not exists" would leave it
     * without one — a NOT NULL read against a missing column throws on every dashboard page.
     */
    alter table github_settings add column if not exists chat_mode text not null default 'everywhere';
    -- Publishing a site is a write like the others, and off until somebody says otherwise.
    alter table github_settings add column if not exists can_deploy_pages boolean not null default false;

    create table if not exists github_chats (
      chat      text primary key,
      chat_name text,
      added_at  timestamptz not null default now()
    );
    -- Deliveries retry, and the same message must not appear twice in a digest.
    create unique index if not exists logged_messages_unique
      on logged_messages (chat, message_id);

    /*
     * Who has chipped in. Yape leaves no trace this app can reach, so those are entered by hand;
     * Buy Me a Coffee has an API, so those carry the external id they came with.
     *
     * The handle column is a normalised WhatsApp identity and is optional: somebody can support
     * without the bot ever needing to know which chat participant they are.
     */
    create table if not exists supporters (
      id          serial primary key,
      name        text        not null,
      handle      text,
      -- yape | coffee | code | other
      via         text        not null default 'other',
      note        text,
      external_id text,
      since       timestamptz not null default now(),
      created_at  timestamptz not null default now()
    );
    -- Partial, so hand-entered rows (which have no external id) never collide with each other.
    create unique index if not exists supporters_external_key
      on supporters (via, external_id) where external_id is not null;
    -- The single supporters.handle is superseded by supporter_handles below; its index goes with
    -- it. Dropping by name rather than leaving the create in place, which would fail on every run
    -- once the column is gone.
    drop index if exists supporters_handle_idx;

    -- How much someone has chipped in, as a count rather than money. Buy Me a Coffee supplies it;
    -- a Yape gift is converted by hand. This is the voting weight, before the cap.
    alter table supporters add column if not exists coffees integer not null default 1;

    /*
     * One person, several identities.
     *
     * WhatsApp gives the same human a phone JID, a LID and now a username, and none is derivable
     * from the others -- wapi maps a phone to a LID and back, and nothing resolves a username at
     * all. So somebody who is 188025162178706 in a group and _cris.fast to his friends needs both
     * recorded, or whichever one you did not type simply never matches and nothing says why.
     *
     * This table is the truth for matching. The old single supporters.handle is folded in below
     * and then dropped, guarded so it happens exactly once.
     */
    create table if not exists supporter_handles (
      -- Unique across everybody: two supporters cannot claim the same identity.
      handle       text primary key,
      supporter_id integer     not null references supporters (id) on delete cascade,
      created_at   timestamptz not null default now()
    );
    create index if not exists supporter_handles_supporter_idx
      on supporter_handles (supporter_id);

    do $$
    begin
      if exists (
        select 1 from information_schema.columns
         where table_name = 'supporters' and column_name = 'handle'
      ) then
        insert into supporter_handles (handle, supporter_id)
        select handle, id from supporters where handle is not null and handle <> ''
        on conflict (handle) do nothing;

        alter table supporters drop column handle;
      end if;
    end $$;

    /*
     * The roadmap. Supporters rank what gets built next; an item only becomes votable once it has
     * been approved, so proposing is open and the list stays curated.
     */
    create table if not exists roadmap_items (
      id          serial primary key,
      title       text        not null,
      detail      text,
      -- proposed | open | shipped | declined
      state       text        not null default 'proposed',
      -- Normalised handle of whoever suggested it; null when it was added from the dashboard.
      proposed_by text,
      created_at  timestamptz not null default now(),
      settled_at  timestamptz
    );
    create index if not exists roadmap_items_state_idx on roadmap_items (state);

    /*
     * One vote per person per item, which the primary key enforces rather than any code. Without
     * it, voting twice would double that person weight in the tally and nothing would say so.
     *
     * The weight is deliberately not stored here: it is looked up when the tally is computed, so
     * buying another coffee strengthens every vote already held instead of needing a backfill.
     */
    create table if not exists roadmap_votes (
      item_id      integer     not null references roadmap_items (id) on delete cascade,
      supporter_id integer     not null references supporters (id) on delete cascade,
      at           timestamptz not null default now(),
      primary key (item_id, supporter_id)
    );

    /*
     * Votes used to key on the handle somebody voted with. Once one person can hold several
     * identities that is a second vote waiting to happen: back an item as your LID, back it again
     * as your username, and the tally counts you twice. Keyed on the supporter it cannot.
     *
     * Rebuilt in place rather than recreated, so any vote already cast survives; guarded on the
     * old column, so it runs on the deployment that first sees this and never again.
     */
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
         where table_name = 'roadmap_votes' and column_name = 'handle'
      ) then
        alter table roadmap_votes add column if not exists supporter_id integer;

        update roadmap_votes v
           set supporter_id = h.supporter_id
          from supporter_handles h
         where h.handle = v.handle;

        -- A vote whose handle belongs to nobody has no weight anyway.
        delete from roadmap_votes where supporter_id is null;

        -- Two identities of one person on the same item collapse to the earlier vote.
        delete from roadmap_votes a
              using roadmap_votes b
              where a.item_id = b.item_id
                and a.supporter_id = b.supporter_id
                and a.ctid > b.ctid;

        alter table roadmap_votes drop constraint if exists roadmap_votes_pkey;
        alter table roadmap_votes drop column handle;
        alter table roadmap_votes alter column supporter_id set not null;
        alter table roadmap_votes add primary key (item_id, supporter_id);
        alter table roadmap_votes
          add constraint roadmap_votes_supporter_fkey
          foreign key (supporter_id) references supporters (id) on delete cascade;
      end if;
    end $$;

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
