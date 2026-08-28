import "server-only";
import { query } from "./db";
import { config } from "./config";
import * as cron from "./cron";

/**
 * Scheduled summaries: read one group, post a digest into another on a cron.
 *
 * This is the only part of the bot that reads messages nobody addressed to it, so the gate is
 * deliberately narrow. A chat is recorded only while it is the source of an **enabled** schedule
 * and the `summaries` feature is on; nothing else is stored, and what is stored is pruned.
 *
 * Recording and summarising are separate on purpose. What a message *was* has to be captured as
 * it arrives — an inbound image is encrypted, and the decrypted URL dies within the hour, so a
 * digest that runs tomorrow can only describe a picture that was described today.
 */

export type Schedule = {
  id: number;
  sourceChat: string;
  sourceName: string | null;
  destinationChat: string;
  destinationName: string | null;
  cron: string;
  enabled: boolean;
  summarisedTo: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
};

type Row = {
  id: number;
  source_chat: string;
  source_name: string | null;
  destination_chat: string;
  destination_name: string | null;
  cron: string;
  enabled: boolean;
  summarised_to: Date | null;
  last_run_at: Date | null;
  last_error: string | null;
};

const COLUMNS =
  "id, source_chat, source_name, destination_chat, destination_name, cron, enabled, summarised_to, last_run_at, last_error";

const toSchedule = (row: Row): Schedule => ({
  id: row.id,
  sourceChat: row.source_chat,
  sourceName: row.source_name,
  destinationChat: row.destination_chat,
  destinationName: row.destination_name,
  cron: row.cron,
  enabled: row.enabled,
  summarisedTo: row.summarised_to,
  lastRunAt: row.last_run_at,
  lastError: row.last_error,
});

export const list = async (): Promise<Schedule[]> => {
  const rows = await query<Row>(`select ${COLUMNS} from summary_schedules order by id`);
  return rows.map(toSchedule);
};

export const create = async (input: {
  sourceChat: string;
  sourceName?: string | null;
  destinationChat: string;
  destinationName?: string | null;
  cron: string;
}): Promise<void> => {
  const valid = cron.validate(input.cron);
  if (!valid.ok) throw new Error(`cron: ${valid.error}`);

  await query(
    `insert into summary_schedules
       (source_chat, source_name, destination_chat, destination_name, cron)
     values ($1, $2, $3, $4, $5)`,
    [
      input.sourceChat,
      input.sourceName ?? null,
      input.destinationChat,
      input.destinationName ?? null,
      input.cron.trim(),
    ],
  );
};

export const setEnabled = (id: number, enabled: boolean): Promise<unknown[]> =>
  query("update summary_schedules set enabled = $2 where id = $1", [id, enabled]);

export const remove = (id: number): Promise<unknown[]> =>
  query("delete from summary_schedules where id = $1", [id]);

/**
 * Which chats to record right now.
 *
 * Cached for half a minute because this is consulted on **every message in every group the bot
 * sits in**, including the ones it ignores. A query per message would put the database in the
 * path of traffic the bot is otherwise free to drop.
 */
const SOURCES_TTL_MS = 30 * 1000;
let cachedSources: { chats: Set<string>; at: number } | undefined;

export const recordedChats = async (): Promise<Set<string>> => {
  const now = Date.now();
  if (cachedSources && now - cachedSources.at < SOURCES_TTL_MS) return cachedSources.chats;

  const rows = await query<{ source_chat: string }>(
    "select distinct source_chat from summary_schedules where enabled",
  );
  const chats = new Set(rows.map((r) => r.source_chat));
  cachedSources = { chats, at: now };
  return chats;
};

/** Called after any change, so switching a schedule on takes effect at once rather than in 30s. */
export const forgetSources = (): void => {
  cachedSources = undefined;
};

export type Logged = {
  chat: string;
  messageId: string;
  sender: string | null;
  senderName: string | null;
  kind: string;
  text: string;
  /** What an image showed, described when it arrived. */
  mediaNote?: string | null;
  /** A re-upload, which does not expire, so the digest can still attach it. */
  mediaUrl?: string | null;
  urls: string[];
};

/** Links are worth pulling out separately: "what did people share?" is half of what a digest is for. */
export const extractUrls = (text: string): string[] => {
  const found = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  // Trailing punctuation is almost always the sentence's, not the URL's.
  return [...new Set(found.map((u) => u.replace(/[.,;:!?)\]]+$/, "")))];
};

/**
 * Store one message. Silently does nothing if it is already stored — deliveries retry, and the
 * same message appearing twice in a digest is worse than not appearing at all.
 */
export const log = async (entry: Logged): Promise<void> => {
  await query(
    `insert into logged_messages
       (chat, message_id, sender, sender_name, kind, text, media_note, media_url, urls)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (chat, message_id) do nothing`,
    [
      entry.chat,
      entry.messageId,
      entry.sender,
      entry.senderName,
      entry.kind,
      entry.text,
      entry.mediaNote ?? null,
      entry.mediaUrl ?? null,
      entry.urls,
    ],
  );
};

export type Window = {
  messages: {
    id: number;
    at: Date;
    senderName: string | null;
    kind: string;
    text: string;
    mediaNote: string | null;
    mediaUrl: string | null;
    urls: string[];
  }[];
  from: Date;
  to: Date;
};

/**
 * Everything said in the window a schedule is due to cover.
 *
 * The window starts at the watermark, or — on the very first run — a day back, which is the
 * useful default for the daily digest almost everyone wants. It ends at the moment the run
 * began rather than "now", so messages arriving mid-summary belong to the next one instead of
 * being dropped between the two.
 */
const FIRST_RUN_LOOKBACK_HOURS = 24;
const MAX_MESSAGES = 600;

export const windowFor = async (schedule: Schedule, until: Date): Promise<Window> => {
  const from =
    schedule.summarisedTo ??
    new Date(until.getTime() - FIRST_RUN_LOOKBACK_HOURS * 3600 * 1000);

  const rows = await query<{
    id: number;
    at: Date;
    sender_name: string | null;
    kind: string;
    text: string;
    media_note: string | null;
    media_url: string | null;
    urls: string[];
  }>(
    `select id, at, sender_name, kind, text, media_note, media_url, urls
       from logged_messages
      where chat = $1 and at > $2 and at <= $3
      order by at
      limit $4`,
    [schedule.sourceChat, from, until, MAX_MESSAGES],
  );

  return {
    from,
    to: until,
    messages: rows.map((r) => ({
      // `bigserial` arrives from pg as a string, and a string id silently fails every numeric
      // comparison downstream. Coerced once, here, rather than defended against everywhere.
      id: Number(r.id),
      at: r.at,
      senderName: r.sender_name,
      kind: r.kind,
      text: r.text,
      mediaNote: r.media_note,
      mediaUrl: r.media_url,
      urls: r.urls ?? [],
    })),
  };
};

/** Local time, so the transcript reads in the timezone the conversation happened in. */
const clock = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone(),
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(at);

export type Rendered = {
  transcript: string;
  /** Picture number as shown in the transcript, to the permanent URL behind it. */
  images: Map<number, string>;
};

/**
 * The transcript the model reads, and the picture numbering that goes with it.
 *
 * One function returning both, because they are the same decision: a number in the transcript is
 * only useful if something can turn it back into a URL, and two functions deriving it separately
 * is a drift waiting to happen.
 *
 * Pictures are numbered **1, 2, 3 within this digest** rather than by their database id. Small
 * numbers are what a model reliably copies back — asked to cite `#4821` it will often answer
 * `3`, meaning the third picture — and the row id is an implementation detail the prompt has no
 * business carrying.
 *
 * Images are given as their description rather than as pixels: they were described once on
 * arrival, and re-reading hundreds of them for every digest would cost more than the digest is
 * worth.
 */
export const render = (window: Window): Rendered => {
  const images = new Map<number, string>();
  let n = 0;

  const lines = window.messages.map((m) => {
    const who = m.senderName ?? "someone";
    const parts: string[] = [];

    if (m.text.trim()) parts.push(m.text.trim());

    if (m.kind === "image") {
      n += 1;
      if (m.mediaUrl) images.set(n, m.mediaUrl);
      parts.push(`[image #${n}${m.mediaNote ? `: ${m.mediaNote}` : ""}]`);
    } else if (m.kind !== "text") {
      parts.push(`[${m.kind}${m.mediaNote ? `: ${m.mediaNote}` : ""}]`);
    }

    if (m.urls.length) parts.push(`[links: ${m.urls.join(" ")}]`);

    return `${clock(m.at)} ${who}: ${parts.join(" ")}`;
  });

  return {
    transcript: lines.length ? lines.join("\n") : "(nothing was said)",
    images,
  };
};

/**
 * Claim a schedule for one firing.
 *
 * The minute key is written in the same statement that reads it, so two ticks in the same minute
 * — a restart, an overlapping timer, a second container — cannot both win. Same reasoning as the
 * reminder lease: the guard has to be the update, not a check before it.
 */
export const claimDue = async (at: Date): Promise<Schedule[]> => {
  const all = await query<Row>(`select ${COLUMNS}, last_minute from summary_schedules where enabled`);
  const timeZone = config.timezone();
  const due: Schedule[] = [];

  for (const row of all) {
    let pattern: cron.Cron;
    try {
      pattern = cron.parse(row.cron);
    } catch {
      // A pattern that stopped parsing must not stall the tick for everyone else.
      continue;
    }
    if (!cron.matches(pattern, at, timeZone)) continue;

    const key = cron.minuteKey(at, timeZone);
    const claimed = await query<{ id: number }>(
      `update summary_schedules
          set last_minute = $2, last_run_at = now()
        where id = $1 and (last_minute is distinct from $2)
        returning id`,
      [row.id, key],
    );
    if (claimed.length > 0) due.push(toSchedule(row));
  }

  return due;
};

/** Only on success: a failed run should cover the same window again, not skip it. */
export const markSummarised = (id: number, upTo: Date): Promise<unknown[]> =>
  query(
    "update summary_schedules set summarised_to = $2, last_error = null where id = $1",
    [id, upTo],
  );

export const markFailed = (id: number, error: string): Promise<unknown[]> =>
  query("update summary_schedules set last_error = $2 where id = $1", [id, error.slice(0, 500)]);

/**
 * Recorded messages are kept only as long as a digest could still need them. Two weeks covers
 * any weekly schedule with room to spare, and nothing here is worth keeping beyond that — this
 * is the one table holding conversation nobody addressed to the bot.
 */
const RETENTION_DAYS = 14;

export const prune = async (): Promise<void> => {
  await query(
    `delete from logged_messages where at < now() - make_interval(days => $1)`,
    [RETENTION_DAYS],
  ).catch((err) =>
    console.warn("[summaries] prune failed:", err instanceof Error ? err.message : err),
  );
};

/** How much is being held for each source, for the dashboard. */
export const recordedCounts = async (): Promise<Map<string, number>> => {
  const rows = await query<{ chat: string; n: string }>(
    "select chat, count(*)::text as n from logged_messages group by chat",
  );
  return new Map(rows.map((r) => [r.chat, Number(r.n)]));
};
