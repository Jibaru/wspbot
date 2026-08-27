import "server-only";
import { config } from "./config";
import { query } from "./db";

/**
 * Scheduled reminders: one per person per chat.
 *
 * That limit is the primary key rather than a check in code, so "set a reminder" and "change my
 * reminder" are the same upsert and cannot drift apart. It also caps the damage a chat can do to
 * itself — a group of ten has at most ten scheduled things, not ten thousand.
 *
 * A reminder stores a *prompt*, not a message. When it fires it is run through the model with
 * every tool available, so "remind me to stretch" and "check whether it will rain and tell me"
 * are the same feature.
 */

/** Below this a repeat is a loop, not a reminder. */
export const MIN_INTERVAL_MINUTES = 5;

/** A guard against a schedule nobody remembers setting: roughly a year of hourly firing. */
const MAX_TOTAL_RUNS = 10_000;

export type Reminder = {
  chat: string;
  userId: string;
  prompt: string;
  askedBy: string | null;
  nextAt: Date;
  everyMinutes: number | null;
  maxRuns: number | null;
  runs: number;
};

type Row = {
  chat: string;
  user_id: string;
  prompt: string;
  asked_by: string | null;
  next_at: Date;
  every_minutes: number | null;
  max_runs: number | null;
  runs: number;
};

const toReminder = (row: Row): Reminder => ({
  chat: row.chat,
  userId: row.user_id,
  prompt: row.prompt,
  askedBy: row.asked_by,
  nextAt: row.next_at,
  everyMinutes: row.every_minutes,
  maxRuns: row.max_runs,
  runs: row.runs,
});

const COLUMNS =
  "chat, user_id, prompt, asked_by, next_at, every_minutes, max_runs, runs";

/** How a time reads to the people in the chat, rather than in UTC. */
export const localTime = (when: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone(),
    dateStyle: "medium",
    timeStyle: "short",
  }).format(when);

/**
 * Now, written the way the model must write scheduled times back: ISO 8601 with an explicit
 * offset. Without the offset in front of it, a model asked for "9am" produces a bare local
 * timestamp that gets read as UTC, and the reminder fires hours out.
 */
export const nowForPrompt = (): string => {
  const now = new Date();
  const tz = config.timezone();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // "GMT-05:00" -> "-05:00"; UTC itself comes back as plain "GMT".
  const offset = get("timeZoneName").replace("GMT", "") || "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}${offset} (${tz})`;
};

export const forChat = async (chat: string): Promise<Reminder[]> => {
  const rows = await query<Row>(
    `select ${COLUMNS} from reminders where chat = $1 order by next_at`,
    [chat],
  );
  return rows.map(toReminder);
};

export const forPerson = async (
  chat: string,
  userId: string,
): Promise<Reminder | null> => {
  const rows = await query<Row>(
    `select ${COLUMNS} from reminders where chat = $1 and user_id = $2`,
    [chat, userId],
  );
  return rows[0] ? toReminder(rows[0]) : null;
};

/** Setting one replaces whatever that person had here — the point of the single-row key. */
export const set = async (input: {
  chat: string;
  userId: string;
  askedBy: string;
  prompt: string;
  nextAt: Date;
  everyMinutes?: number | null;
  maxRuns?: number | null;
}): Promise<Reminder> => {
  const rows = await query<Row>(
    `insert into reminders (chat, user_id, prompt, asked_by, next_at, every_minutes, max_runs, runs)
     values ($1, $2, $3, $4, $5, $6, $7, 0)
     on conflict (chat, user_id) do update set
       prompt = excluded.prompt,
       asked_by = excluded.asked_by,
       next_at = excluded.next_at,
       every_minutes = excluded.every_minutes,
       max_runs = excluded.max_runs,
       -- Reset: a changed reminder is a new one, not a continuation of the old count.
       runs = 0,
       created_at = now()
     returning ${COLUMNS}`,
    [
      input.chat,
      input.userId,
      input.prompt,
      input.askedBy,
      input.nextAt,
      input.everyMinutes ?? null,
      input.maxRuns ?? null,
    ],
  );
  return toReminder(rows[0]!);
};

export const cancel = async (chat: string, userId: string): Promise<Reminder | null> => {
  const rows = await query<Row>(
    `delete from reminders where chat = $1 and user_id = $2 returning ${COLUMNS}`,
    [chat, userId],
  );
  return rows[0] ? toReminder(rows[0]) : null;
};

/**
 * How long a claimed one-off stays un-claimable while it runs. Long enough that a slow run
 * cannot be picked up again, short enough that a crashed one is retried rather than lost.
 */
const LEASE_MINUTES = 60;

/**
 * Claims what is due, moving each one out of the way in the same statement.
 *
 * A single `update ... returning`, so two overlapping ticks or two instances cannot both take
 * the same row — whoever wins the update owns that run.
 *
 * A one-off gets its `next_at` pushed forward too, not left alone. Leaving it meant the row was
 * still due while it ran, and any run slower than the tick fired it a second time; `retire`
 * deletes it moments later, so the lease is only ever reached if the process died mid-run.
 */
export const claimDue = async (limit = 10): Promise<Reminder[]> => {
  const rows = await query<Row>(
    `update reminders r
        set runs = r.runs + 1,
            next_at = case
              when r.every_minutes is null
                then now() + make_interval(mins => $2)
              else greatest(now(), r.next_at) + make_interval(mins => r.every_minutes)
            end
      where (r.chat, r.user_id) in (
        select chat, user_id from reminders
         where next_at <= now()
         order by next_at
         limit $1
         for update skip locked
      )
      returning ${COLUMNS}`,
    [limit, LEASE_MINUTES],
  );
  return rows.map(toReminder);
};

/**
 * Removes a reminder that has nothing left to do: a one-off that has fired, or a repeat that has
 * reached its limit. Called after the run, so a failure does not silently drop it.
 */
export const retireIfFinished = async (reminder: Reminder): Promise<boolean> => {
  const finished =
    reminder.everyMinutes === null ||
    (reminder.maxRuns !== null && reminder.runs + 1 >= reminder.maxRuns) ||
    reminder.runs + 1 >= MAX_TOTAL_RUNS;

  if (!finished) return false;
  await query("delete from reminders where chat = $1 and user_id = $2", [
    reminder.chat,
    reminder.userId,
  ]);
  return true;
};

/** Rendered into the system prompt, so "what have I got set?" needs no tool call. */
export const render = (reminders: Reminder[]): string => {
  if (reminders.length === 0) return "(nothing scheduled in this chat)";
  return reminders
    .map((r) => {
      const cadence = r.everyMinutes
        ? `every ${r.everyMinutes} min`
        : "once";
      const limit = r.maxRuns ? `, ${r.maxRuns - r.runs} run(s) left` : "";
      return `- ${r.askedBy ?? "someone"}: "${r.prompt}" — next ${localTime(r.nextAt)}, ${cadence}${limit}`;
    })
    .join("\n");
};
