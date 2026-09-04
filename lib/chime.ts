import "server-only";
import { query } from "./db";
import { config } from "./config";

/**
 * Chiming in: saying something nobody asked for.
 *
 * Everything else the bot does starts with somebody tagging it. This is the one thing that
 * starts with the room going quiet, or a conversation running along without it, and the bot
 * deciding a person would have said something by now.
 *
 * That makes it the feature with the most ways to be *annoying*, so nearly all of it is
 * restraint. A chime needs, all at once:
 *
 * - the feature on, and this chat set up for it
 * - at least `every_minutes` since the last one — the floor on how often it can speak
 * - at least `min_messages` new messages since it last spoke, so it joins a conversation
 *   rather than talking to an empty room
 * - the newest of those messages to be recent, so it does not answer something from this
 *   morning as if it had just been said
 * - to be outside quiet hours, in the bot's timezone
 * - to be under the daily cap
 *
 * Any one of those failing means silence, and silence is the correct outcome — it is what a
 * person in a group does almost all the time.
 *
 * It reads the same `logged_messages` the digests are built from, which is why enabling this
 * starts recording a group exactly as a summary schedule does. Same gate, same fortnight of
 * retention, same honesty in the system prompt when somebody asks whether it is listening.
 */

export type Settings = {
  chat: string;
  chatName: string | null;
  enabled: boolean;
  /** The floor on how often it may speak, in minutes. */
  everyMinutes: number;
  /** New messages needed since it last spoke before it may speak again. */
  minMessages: number;
  /** Local hours, `from` inclusive and `to` exclusive; equal means never quiet. */
  quietFrom: number;
  quietTo: number;
  maxPerDay: number;
  /** A steer for this group in particular — what it is, how to behave in it. */
  note: string | null;
  /** Everything after this has already been taken into account. */
  chimedTo: Date | null;
  lastChimeAt: Date | null;
  lastError: string | null;
};

type Row = {
  chat: string;
  chat_name: string | null;
  enabled: boolean;
  every_minutes: number;
  min_messages: number;
  quiet_from: number;
  quiet_to: number;
  max_per_day: number;
  note: string | null;
  chimed_to: Date | null;
  last_chime_at: Date | null;
  last_error: string | null;
};

const COLUMNS =
  "chat, chat_name, enabled, every_minutes, min_messages, quiet_from, quiet_to, max_per_day, note, chimed_to, last_chime_at, last_error";

const toSettings = (row: Row): Settings => ({
  chat: row.chat,
  chatName: row.chat_name,
  enabled: row.enabled,
  // `integer` columns come back as numbers, unlike bigints — but the coercion costs nothing and
  // makes every comparison below safe regardless of what the column type becomes later.
  everyMinutes: Number(row.every_minutes),
  minMessages: Number(row.min_messages),
  quietFrom: Number(row.quiet_from),
  quietTo: Number(row.quiet_to),
  maxPerDay: Number(row.max_per_day),
  note: row.note,
  chimedTo: row.chimed_to,
  lastChimeAt: row.last_chime_at,
  lastError: row.last_error,
});

export const list = async (): Promise<Settings[]> => {
  const rows = await query<Row>(`select ${COLUMNS} from chime_settings order by chat`);
  return rows.map(toSettings);
};

export const forChat = async (chat: string): Promise<Settings | null> => {
  const rows = await query<Row>(`select ${COLUMNS} from chime_settings where chat = $1`, [chat]);
  return rows[0] ? toSettings(rows[0]) : null;
};

export const DEFAULTS = {
  everyMinutes: 90,
  minMessages: 8,
  quietFrom: 23,
  quietTo: 8,
  maxPerDay: 4,
} as const;

/** Bounds, not preferences: a cadence of one minute would be a bot spamming a group. */
const MIN_EVERY = 15;
const MAX_EVERY = 24 * 60;
const MIN_MESSAGES_FLOOR = 2;
const MAX_PER_DAY_CEILING = 12;

const clamp = (n: number, low: number, high: number, fallback: number): number =>
  Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;

const hour = (n: number, fallback: number): number =>
  Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;

export type Input = {
  chat: string;
  chatName?: string | null;
  everyMinutes?: number;
  minMessages?: number;
  quietFrom?: number;
  quietTo?: number;
  maxPerDay?: number;
  note?: string | null;
};

/**
 * Add a group, or change one. One statement rather than an insert and an update, because the
 * dashboard's form is the same form either way and a two-step version would need to know which.
 */
export const save = async (input: Input): Promise<void> => {
  const everyMinutes = clamp(
    input.everyMinutes ?? DEFAULTS.everyMinutes,
    MIN_EVERY,
    MAX_EVERY,
    DEFAULTS.everyMinutes,
  );
  const minMessages = clamp(
    input.minMessages ?? DEFAULTS.minMessages,
    MIN_MESSAGES_FLOOR,
    200,
    DEFAULTS.minMessages,
  );
  const maxPerDay = clamp(
    input.maxPerDay ?? DEFAULTS.maxPerDay,
    1,
    MAX_PER_DAY_CEILING,
    DEFAULTS.maxPerDay,
  );

  await query(
    `insert into chime_settings
       (chat, chat_name, every_minutes, min_messages, quiet_from, quiet_to, max_per_day, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chat) do update set
       chat_name     = excluded.chat_name,
       every_minutes = excluded.every_minutes,
       min_messages  = excluded.min_messages,
       quiet_from    = excluded.quiet_from,
       quiet_to      = excluded.quiet_to,
       max_per_day   = excluded.max_per_day,
       note          = excluded.note`,
    [
      input.chat,
      input.chatName ?? null,
      everyMinutes,
      minMessages,
      hour(input.quietFrom ?? DEFAULTS.quietFrom, DEFAULTS.quietFrom),
      hour(input.quietTo ?? DEFAULTS.quietTo, DEFAULTS.quietTo),
      maxPerDay,
      input.note?.trim() || null,
    ],
  );
};

export const setEnabled = (chat: string, enabled: boolean): Promise<unknown[]> =>
  query("update chime_settings set enabled = $2 where chat = $1", [chat, enabled]);

export const remove = (chat: string): Promise<unknown[]> =>
  query("delete from chime_settings where chat = $1", [chat]);

/**
 * Which chats to record for this, cached for the same reason and the same half-minute as the
 * summaries one: it is consulted for every message in every group the bot sits in.
 */
const CHATS_TTL_MS = 30 * 1000;
let cached: { chats: Set<string>; at: number } | undefined;

export const chimedChats = async (): Promise<Set<string>> => {
  const now = Date.now();
  if (cached && now - cached.at < CHATS_TTL_MS) return cached.chats;

  const rows = await query<{ chat: string }>("select chat from chime_settings where enabled");
  const chats = new Set(rows.map((r) => r.chat));
  cached = { chats, at: now };
  return chats;
};

/** Called after any change here, so enabling a group starts recording it now rather than in 30s. */
export const forget = (): void => {
  cached = undefined;
};

/** The hour of the day where the bot lives, which is the only clock a quiet hour can mean. */
export const localHour = (at: Date): number =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone(),
      hour: "2-digit",
      hour12: false,
    }).format(at),
  ) % 24;

/**
 * Quiet hours wrap around midnight, which is the whole difficulty: 23→8 is a range that contains
 * neither of its endpoints in the usual order. Written out rather than clever, because the bug
 * this would otherwise have is "the bot messaged the group at four in the morning".
 */
export const isQuiet = (settings: Settings, at: Date): boolean => {
  const { quietFrom: from, quietTo: to } = settings;
  if (from === to) return false;
  const h = localHour(at);
  return from < to ? h >= from && h < to : h >= from || h < to;
};

/** The local day, as a key. Used for the daily cap, which is a *local* day to whoever reads it. */
export const dayKey = (at: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** On the first run for a chat, how far back to look for a conversation to join. */
const FIRST_LOOKBACK_MINUTES = 120;

/** A conversation older than this is over; joining it now would read as answering yesterday. */
export const FRESH_MINUTES = 25;

/** Enough to know what is going on without paying for a day of chatter. */
const MAX_MESSAGES = 120;

export type Window = {
  from: Date;
  to: Date;
  messages: {
    at: Date;
    senderName: string | null;
    kind: string;
    text: string;
    mediaNote: string | null;
    urls: string[];
  }[];
  /** When the most recent of them arrived, or null if there were none. */
  newestAt: Date | null;
};

export const windowFor = async (settings: Settings, until: Date): Promise<Window> => {
  const from =
    settings.chimedTo ?? new Date(until.getTime() - FIRST_LOOKBACK_MINUTES * 60 * 1000);

  const rows = await query<{
    at: Date;
    sender_name: string | null;
    kind: string;
    text: string;
    media_note: string | null;
    urls: string[];
  }>(
    `select at, sender_name, kind, text, media_note, urls
       from logged_messages
      where chat = $1 and at > $2 and at <= $3
      order by at
      limit $4`,
    [settings.chat, from, until, MAX_MESSAGES],
  );

  const messages = rows.map((r) => ({
    at: r.at,
    senderName: r.sender_name,
    kind: r.kind,
    text: r.text,
    mediaNote: r.media_note,
    urls: r.urls ?? [],
  }));

  return {
    from,
    to: until,
    messages,
    newestAt: messages.length ? (messages[messages.length - 1]!.at ?? null) : null,
  };
};

const clock = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone(),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);

/**
 * What the model reads: the conversation as it happened, nothing else.
 *
 * No picture ids and no attachable URLs, unlike a digest — this is not a report *about* the
 * conversation, it is the bot catching up on it before saying something, and everything extra
 * in here is something it might mistake for a thing it is supposed to do.
 */
export const render = (window: Window): string =>
  window.messages
    .map((m) => {
      const who = m.senderName ?? "someone";
      const body =
        m.text.trim() ||
        (m.mediaNote ? `[sent a picture: ${m.mediaNote}]` : `[sent ${m.kind === "text" ? "something" : `a ${m.kind}`}]`);
      const note = m.text.trim() && m.mediaNote ? ` [picture: ${m.mediaNote}]` : "";
      return `${clock(m.at)} ${who}: ${body}${note}`;
    })
    .join("\n");

/**
 * Take the next chime for this chat, if it is owed one.
 *
 * The claim is a single conditional update, so two ticks — or two containers — cannot both
 * decide the same chat is due. `last_chime_at` moves **on the claim, not on success**, for the
 * reason the reminder runner learned the hard way: a row still due while it is being worked on
 * fires twice the moment a run takes longer than the tick.
 */
export const claim = async (chat: string, now: Date): Promise<boolean> => {
  const rows = await query(
    `update chime_settings
        set last_chime_at = $2
      where chat = $1
        and enabled
        and (last_chime_at is null
             -- The cast is load-bearing: without it pg types the parameter from its
             -- neighbour and reads "$2 - interval" as interval minus interval.
             or last_chime_at <= $2::timestamptz - make_interval(mins => every_minutes))
      returning chat`,
    [chat, now],
  );
  return rows.length > 0;
};

/** How many times it has spoken here today, for the daily cap. */
export const spokenToday = async (chat: string, now: Date): Promise<number> => {
  const rows = await query<{ count: string }>(
    "select count(*)::text as count from chimes where chat = $1 and day = $2",
    [chat, dayKey(now)],
  );
  return Number(rows[0]?.count ?? 0);
};

/** Written after the fact: what it said, and when, so the cap and the dashboard can both read it. */
export const record = async (chat: string, text: string, at: Date): Promise<void> => {
  await query("insert into chimes (chat, day, text, at) values ($1, $2, $3, $4)", [
    chat,
    dayKey(at),
    text.slice(0, 2000),
    at,
  ]);
};

export const recent = async (chat: string, limit = 5): Promise<{ at: Date; text: string }[]> => {
  const rows = await query<{ at: Date; text: string }>(
    "select at, text from chimes where chat = $1 order by at desc limit $2",
    [chat, limit],
  );
  return rows;
};

/** The watermark. Moved only after something actually went out. */
export const markChimed = (chat: string, upTo: Date): Promise<unknown[]> =>
  query("update chime_settings set chimed_to = $2, last_error = null where chat = $1", [
    chat,
    upTo,
  ]);

export const markFailed = (chat: string, why: string): Promise<unknown[]> =>
  query("update chime_settings set last_error = $2 where chat = $1", [chat, why.slice(0, 500)]);

/**
 * Why this chat is not going to be spoken in right now, or null if it is.
 *
 * Returned as a sentence rather than a boolean because it is shown on the dashboard: "nothing
 * happened" and "it is asleep" and "it already said its piece today" are three very different
 * things to see next to a group that has gone silent, and a bare "not due" explains none of it.
 */
export const holdReason = async (settings: Settings, now: Date): Promise<string | null> => {
  if (!settings.enabled) return "switched off";
  if (isQuiet(settings, now)) return `quiet hours (${settings.quietFrom}:00–${settings.quietTo}:00)`;

  if (settings.lastChimeAt) {
    const dueAt = new Date(settings.lastChimeAt.getTime() + settings.everyMinutes * 60 * 1000);
    if (dueAt > now) {
      const mins = Math.ceil((dueAt.getTime() - now.getTime()) / 60000);
      return `spoke recently — ${mins} min to go`;
    }
  }

  if ((await spokenToday(settings.chat, now)) >= settings.maxPerDay) {
    return `reached today's limit of ${settings.maxPerDay}`;
  }

  const window = await windowFor(settings, now);
  if (window.messages.length < settings.minMessages) {
    return `only ${window.messages.length} new message${window.messages.length === 1 ? "" : "s"}, needs ${settings.minMessages}`;
  }
  if (
    !window.newestAt ||
    now.getTime() - window.newestAt.getTime() > FRESH_MINUTES * 60 * 1000
  ) {
    return "the conversation has gone quiet";
  }

  return null;
};
