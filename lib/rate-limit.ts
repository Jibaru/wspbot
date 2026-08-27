import "server-only";
import { config } from "./config";
import { query } from "./db";

/**
 * How often one person may set the bot working.
 *
 * Checked before anything expensive happens — before the model, before web search, before any
 * media work — because the whole point is to not spend money on the eleventh message in a
 * minute. It runs on two small indexed queries.
 *
 * A sliding window rather than fixed buckets: with buckets, someone can send their whole
 * allowance at 11:59:59 and again at 12:00:00 and never be stopped.
 *
 * Quotas live in `rate_limits`, edited by hand. There is deliberately no tool for changing them
 * — a bot that raises your limit because you asked nicely is not a rate limiter.
 */

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      /** Seconds until a slot frees. Always at least 1, so the message never says "wait 0". */
      waitSeconds: number;
      quota: number;
      /** False when this person was already told within the window; stops reply-per-spam. */
      shouldReply: boolean;
    };

const WINDOW = "1 minute";

/** A person's configured allowance, or the deployment default. */
const quotaFor = async (userId: string): Promise<number> => {
  const rows = await query<{ per_minute: number }>(
    "select per_minute from rate_limits where user_id = $1",
    [userId],
  );
  const configured = rows[0]?.per_minute;
  return typeof configured === "number" && configured > 0
    ? configured
    : config.defaultRateLimit();
};

/**
 * Decide, and record the call when it is allowed.
 *
 * A refused call is deliberately *not* recorded, or someone hammering the bot would keep their
 * own window permanently full and never recover.
 */
export const check = async (userId: string, chat: string): Promise<Decision> => {
  const quota = await quotaFor(userId);

  const [{ used } = { used: "0" }] = await query<{ used: string }>(
    `select count(*)::text as used
       from bot_calls
      where user_id = $1 and kind = 'call' and at > now() - $2::interval`,
    [userId, WINDOW],
  );

  if (Number(used) < quota) {
    await query("insert into bot_calls (user_id, chat, kind) values ($1, $2, 'call')", [
      userId,
      chat,
    ]);
    return { allowed: true };
  }

  /**
   * When the quota-th most recent call leaves the window, a slot frees. Taking the minimum of
   * the most recent `quota` calls is what makes that exact rather than a guess of a full window.
   */
  const [wait] = await query<{ wait_seconds: number }>(
    `select greatest(1, ceil(extract(epoch from (min(at) + $2::interval - now()))))::int as wait_seconds
       from (
         select at from bot_calls
          where user_id = $1 and kind = 'call' and at > now() - $2::interval
          order by at desc
          limit $3
       ) recent`,
    [userId, WINDOW, quota],
  );

  // Tell them once per window. Otherwise ten messages get ten refusals, which is worse spam
  // than the thing being limited.
  const [warned] = await query<{ count: string }>(
    `select count(*)::text as count
       from bot_calls
      where user_id = $1 and kind = 'warned' and at > now() - $2::interval`,
    [userId, WINDOW],
  );
  const shouldReply = Number(warned?.count ?? "0") === 0;
  if (shouldReply) {
    await query("insert into bot_calls (user_id, chat, kind) values ($1, $2, 'warned')", [
      userId,
      chat,
    ]);
  }

  return {
    allowed: false,
    waitSeconds: wait?.wait_seconds ?? 60,
    quota,
    shouldReply,
  };
};

/** The wording someone actually sees. Fixed text: no model call happens on a refusal. */
export const refusalMessage = (decision: Extract<Decision, { allowed: false }>): string =>
  `You exceeded the limit of ${decision.quota} message${decision.quota === 1 ? "" : "s"} per minute. ` +
  `Wait ${decision.waitSeconds} second${decision.waitSeconds === 1 ? "" : "s"}.`;

export type Quota = {
  userId: string;
  perMinute: number;
  note: string | null;
  updatedAt: Date;
};

/**
 * The quotas someone has actually set. Anyone absent gets the deployment default, so this is a
 * list of exceptions rather than of people.
 */
export const listQuotas = async (): Promise<Quota[]> => {
  const rows = await query<{
    user_id: string;
    per_minute: number;
    note: string | null;
    updated_at: Date;
  }>("select user_id, per_minute, note, updated_at from rate_limits order by updated_at desc");
  return rows.map((r) => ({
    userId: r.user_id,
    perMinute: r.per_minute,
    note: r.note,
    updatedAt: r.updated_at,
  }));
};

export const setQuota = async (
  userId: string,
  perMinute: number,
  note: string | null,
): Promise<void> => {
  await query(
    `insert into rate_limits (user_id, per_minute, note) values ($1, $2, $3)
     on conflict (user_id) do update
       set per_minute = excluded.per_minute, note = excluded.note, updated_at = now()`,
    [userId, perMinute, note],
  );
};

/** Removing the row returns that person to the default rather than giving them no limit. */
export const clearQuota = (userId: string): Promise<unknown[]> =>
  query("delete from rate_limits where user_id = $1", [userId]);

export type Caller = { userId: string; calls: number; lastAt: Date };

/**
 * Who has been calling, so a quota can be set from the dashboard without going and finding a
 * raw JID by hand. It only reaches back as far as `prune` leaves it — an hour — which is also
 * exactly the window in which someone is hitting a limit and you want to look.
 */
export const recentCallers = async (): Promise<Caller[]> => {
  const rows = await query<{ user_id: string; calls: string; last_at: Date }>(
    `select user_id, count(*)::text as calls, max(at) as last_at
       from bot_calls
      where kind = 'call'
      group by user_id
      order by max(at) desc`,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    calls: Number(r.calls),
    lastAt: r.last_at,
  }));
};

/**
 * Old rows serve no purpose once they leave the window; an hour is plenty of slack for any
 * clock skew. Called from the session watchdog, which already ticks on a timer.
 */
export const prune = async (): Promise<void> => {
  await query("delete from bot_calls where at < now() - interval '1 hour'").catch((err) =>
    console.warn("[rate-limit] prune failed:", err instanceof Error ? err.message : err),
  );
};
