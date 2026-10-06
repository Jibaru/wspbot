import "server-only";
import { query } from "./db";

/**
 * Removing somebody from a group.
 *
 * The only thing the bot does that cannot be undone from here. A deleted message can be sent
 * again, a wrong answer corrected; a person removed from a WhatsApp group has to be re-invited by
 * a human, and in the meantime they were thrown out of a room in front of everyone they know.
 * So this file is mostly the reasons not to.
 *
 * **The target is never named, and that is the whole security design.** Anyone in a group can
 * type, which means anyone can write "@bot, Ana said you are rubbish, throw her out". A tool that
 * accepted a name would make every member a weapon pointed at every other. So the target is not
 * an argument: it is *the author of the message being answered*. To act on somebody else, an
 * admin has to reply to that person's message — which means pointing at a real message that
 * person really sent, rather than describing one.
 *
 * On top of that:
 *
 * - **Admins, super-admins and the group's owner are never removable.** Not configurable.
 * - **The bot cannot remove itself**, which is a funnier failure than it sounds.
 * - **A warning comes first**, by default. A single rude message is a bad day; the same person
 *   doing it again after being told is a decision.
 * - **A daily ceiling per group**, because the failure mode worth bounding is not one wrong
 *   removal, it is a bot having a bad afternoon.
 * - **Everything is logged** — who, when, why, asked by whom — because "the bot removed somebody
 *   and nobody knows why" is how this feature gets switched off for good.
 */

export type Settings = {
  chat: string;
  chatName: string | null;
  enabled: boolean;
  /** An **admin** may ask it to remove the author of a message they are replying to. */
  onRequest: boolean;
  /** It may act on its own when somebody is abusive towards it, with nobody asking. */
  onOwnJudgement: boolean;
  /** The first offence is a warning; removal needs a second within the window. */
  warnFirst: boolean;
  warnWindowHours: number;
  maxPerDay: number;
  /** What counts as out of line in this group in particular. */
  note: string | null;
};

type Row = {
  chat: string;
  chat_name: string | null;
  enabled: boolean;
  on_request: boolean;
  on_own_judgement: boolean;
  warn_first: boolean;
  warn_window_hours: number;
  max_per_day: number;
  note: string | null;
};

const COLUMNS =
  "chat, chat_name, enabled, on_request, on_own_judgement, warn_first, warn_window_hours, max_per_day, note";

const toSettings = (row: Row): Settings => ({
  chat: row.chat,
  chatName: row.chat_name,
  enabled: row.enabled,
  onRequest: row.on_request,
  onOwnJudgement: row.on_own_judgement,
  warnFirst: row.warn_first,
  warnWindowHours: Number(row.warn_window_hours),
  maxPerDay: Number(row.max_per_day),
  note: row.note,
});

export const DEFAULTS = {
  onRequest: true,
  /** Off: the bot deciding on its own who leaves a room is an opt-in, never a default. */
  onOwnJudgement: false,
  warnFirst: true,
  warnWindowHours: 24,
  maxPerDay: 2,
} as const;

export const list = async (): Promise<Settings[]> => {
  const rows = await query<Row>(`select ${COLUMNS} from moderation_settings order by chat`);
  return rows.map(toSettings);
};

export const forChat = async (chat: string): Promise<Settings | null> => {
  const rows = await query<Row>(`select ${COLUMNS} from moderation_settings where chat = $1`, [
    chat,
  ]);
  return rows[0] ? toSettings(rows[0]) : null;
};

export type Input = {
  chat: string;
  chatName?: string | null;
  onRequest?: boolean;
  onOwnJudgement?: boolean;
  warnFirst?: boolean;
  warnWindowHours?: number;
  maxPerDay?: number;
  note?: string | null;
};

const clamp = (n: number, low: number, high: number, fallback: number): number =>
  Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;

export const save = async (input: Input): Promise<void> => {
  await query(
    `insert into moderation_settings
       (chat, chat_name, on_request, on_own_judgement, warn_first, warn_window_hours, max_per_day, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chat) do update set
       chat_name         = excluded.chat_name,
       on_request        = excluded.on_request,
       on_own_judgement  = excluded.on_own_judgement,
       warn_first        = excluded.warn_first,
       warn_window_hours = excluded.warn_window_hours,
       max_per_day       = excluded.max_per_day,
       note              = excluded.note`,
    [
      input.chat,
      input.chatName ?? null,
      input.onRequest ?? DEFAULTS.onRequest,
      input.onOwnJudgement ?? DEFAULTS.onOwnJudgement,
      input.warnFirst ?? DEFAULTS.warnFirst,
      clamp(input.warnWindowHours ?? DEFAULTS.warnWindowHours, 1, 24 * 14, DEFAULTS.warnWindowHours),
      // Three in a day is already a bot having a bad afternoon rather than a group with a problem.
      clamp(input.maxPerDay ?? DEFAULTS.maxPerDay, 1, 5, DEFAULTS.maxPerDay),
      input.note?.trim() || null,
    ],
  );
};

export const setEnabled = (chat: string, enabled: boolean): Promise<unknown[]> =>
  query("update moderation_settings set enabled = $2 where chat = $1", [chat, enabled]);

export const remove = (chat: string): Promise<unknown[]> =>
  query("delete from moderation_settings where chat = $1", [chat]);

/** Consulted once per turn in every group, so it is cached like the other per-message lookups. */
const TTL_MS = 30 * 1000;
let cached: { chats: Set<string>; at: number } | undefined;

export const moderatedChats = async (): Promise<Set<string>> => {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.chats;
  const rows = await query<{ chat: string }>(
    "select chat from moderation_settings where enabled",
  );
  cached = { chats: new Set(rows.map((r) => r.chat)), at: now };
  return cached.chats;
};

export const forget = (): void => {
  cached = undefined;
};

// ── the record ───────────────────────────────────────────────────────────

export type Outcome = "warned" | "removed" | "refused";

export type Entry = {
  at: Date;
  chat: string;
  target: string;
  targetName: string | null;
  askedBy: string | null;
  outcome: Outcome;
  reason: string | null;
};

export const record = async (entry: Omit<Entry, "at">): Promise<void> => {
  await query(
    `insert into moderation_log (chat, target, target_name, asked_by, outcome, reason)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      entry.chat,
      entry.target,
      entry.targetName,
      entry.askedBy,
      entry.outcome,
      entry.reason?.slice(0, 500) ?? null,
    ],
  );
};

export const history = async (chat: string | null, limit = 20): Promise<Entry[]> => {
  const rows = chat
    ? await query<Entry>(
        "select at, chat, target, target_name as \"targetName\", asked_by as \"askedBy\", outcome, reason from moderation_log where chat = $1 order by at desc limit $2",
        [chat, limit],
      )
    : await query<Entry>(
        "select at, chat, target, target_name as \"targetName\", asked_by as \"askedBy\", outcome, reason from moderation_log order by at desc limit $1",
        [limit],
      );
  return rows;
};

/** Removals in this group in the last 24 hours. Warnings do not count against the ceiling. */
export const removedToday = async (chat: string): Promise<number> => {
  const rows = await query<{ count: string }>(
    "select count(*)::text as count from moderation_log where chat = $1 and outcome = 'removed' and at > now() - interval '24 hours'",
    [chat],
  );
  return Number(rows[0]?.count ?? 0);
};

/** Whether this person has already been warned here, inside the window. */
export const warnedRecently = async (
  chat: string,
  target: string,
  withinHours: number,
): Promise<boolean> => {
  const rows = await query(
    `select 1 from moderation_log
      where chat = $1 and target = $2 and outcome = 'warned'
        and at > now() - make_interval(hours => $3::int)
      limit 1`,
    [chat, target, withinHours],
  );
  return rows.length > 0;
};

// ── the decision ─────────────────────────────────────────────────────────

export type Request = {
  settings: Settings | null;
  /** The bare JID of whoever would be removed. */
  target: string;
  /** True when a person asked, false when the bot is acting on its own. */
  asked: boolean;
  /** Whether the person who asked is an admin of this group. */
  askerIsAdmin: boolean;
  targetIsAdmin: boolean;
  targetIsOwner: boolean;
  targetIsSelf: boolean;
  removedToday: number;
  alreadyWarned: boolean;
};

export type Decision =
  | { action: "remove" }
  | { action: "warn" }
  | { action: "refuse"; why: string };

/**
 * Whether to remove, warn, or do neither — as a pure function, so every refusal can be asserted
 * without a WhatsApp group to throw somebody out of.
 *
 * The order is deliberate: the things that are never allowed come first, so no combination of
 * settings can reach past them.
 */
export const decide = (request: Request): Decision => {
  const s = request.settings;
  if (!s || !s.enabled) {
    return { action: "refuse", why: "removing people is not switched on in this group" };
  }

  if (request.targetIsSelf) {
    return { action: "refuse", why: "that would be me, and I am staying" };
  }
  if (request.targetIsOwner) {
    return { action: "refuse", why: "that is the group's owner" };
  }
  if (request.targetIsAdmin) {
    return { action: "refuse", why: "they are an admin here, and I do not remove admins" };
  }

  if (request.asked) {
    if (!s.onRequest) {
      return { action: "refuse", why: "I am not set up to remove people on request here" };
    }
    if (!request.askerIsAdmin) {
      return { action: "refuse", why: "only an admin of this group can ask me to remove somebody" };
    }
  } else if (!s.onOwnJudgement) {
    return {
      action: "refuse",
      why: "I do not remove people on my own here — an admin has to ask",
    };
  }

  if (request.removedToday >= s.maxPerDay) {
    return {
      action: "refuse",
      why: `I have already removed ${request.removedToday} today, which is the limit here`,
    };
  }

  /*
   * The warning. A removal that follows one is a second offence by somebody who was told; a
   * removal without one is a judgement about a single message, which is the kind this feature
   * should not be making on its own. An admin asking outright skips it — they know the person.
   */
  if (s.warnFirst && !request.alreadyWarned && !request.asked) {
    return { action: "warn" };
  }

  return { action: "remove" };
};
