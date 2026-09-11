import "server-only";
import { z } from "zod";
import { config } from "./config";
import { query } from "./db";
import * as cron from "./cron";
/*
 * The local clock, borrowed rather than written again. The midnight wrap in `quiet` is the one
 * piece of arithmetic here whose bug is "it messaged the group at four in the morning", so there
 * is exactly one implementation of it and `npm run chime-check` asserts both directions.
 */
import { quiet, localHour, dayKey } from "./chime";

/**
 * Where a project stands in a public vote leaderboard, and what it would take to move up.
 *
 * **Every number is read, never taken off a picture.** The obvious way to put a leaderboard into
 * WhatsApp is `capture` from `lib/render-html.ts` — the page exists, it looks good, and a
 * screenshot is one call. As the *source*, it is the wrong tool twice over: it makes the model
 * read figures off an image, which is the single place it is confidently wrong, and it starts
 * Chromium on a box that is also running Postgres and the whole wapi stack. The site publishes
 * its own JSON, so the arithmetic happens here, exactly, for nothing.
 *
 * A picture is still attached to an announcement, and the two are not in tension: the text
 * carries the figures and the screenshot is what makes a message nobody asked for worth opening.
 * It is decoration with a job, and if the capture fails the message goes out without it.
 *
 * **The gap is the whole feature, and it is an off-by-one waiting to happen.** Ties share a
 * position — nine projects on nought votes are all seventeenth — so "the next position" is not
 * the row above in the list. It is the next *distinct higher vote total*, and everybody holding
 * it has to be passed. `standing` computes it that way; `scripts/leaderboard-check.mts` asserts
 * it against fixtures, and against the arithmetic the site itself prints.
 */

/** The site's own internal route. Not a documented contract — see `Payload` below. */
const PATH = "/api/leaderboard";

/** Long enough for a cold serverless read, short enough not to stall a turn. */
const TIMEOUT_MS = 8_000;

/**
 * The page polls every 15 seconds. Several people asking at once in a group is one read, not
 * one each; a schedule firing on the same minute as a question is one read too.
 */
const TTL_MS = 20_000;

const ProjectSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  track: z.string().optional(),
  votes: z.number().int().nonnegative(),
  /** The upstream count for this row could not be refreshed; its votes may be behind. */
  stale: z.boolean().optional(),
});

/**
 * Validated rather than trusted, because this endpoint is the leaderboard's own internal route
 * and nobody promised it would keep its shape. A payload that no longer parses has to surface as
 * "I could not read the board" — the one thing that must never happen is a plausible number
 * assembled out of a changed field.
 */
const PayloadSchema = z.object({
  projects: z.array(ProjectSchema),
  updatedAt: z.string().optional(),
  live: z.boolean().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

export type Reading = {
  projects: Project[];
  /** When the upstream votes were last refreshed, per the feed itself. */
  at: Date | null;
  /** False when the feed knows it is not current. Absent means it did not say, so assume live. */
  live: boolean;
};

export type Standing = {
  me: Project;
  /** One-based. Ties share a position, so this is "how many are strictly ahead", plus one. */
  position: number;
  /** Somebody else has exactly these votes, so the position is shared. */
  shared: boolean;
  of: number;
  totalVotes: number;
  /**
   * The next position up: the smallest vote total above this one, and what it costs to reach.
   * `null` at the top. `toBeat` passes them, `toTie` draws level and shares the position — two
   * different answers to "how many do I need", and the difference is exactly one.
   */
  next: { name: string; votes: number; toBeat: number; toTie: number } | null;
  /**
   * The top of the board, and what it costs to take it. `null` when we are already there.
   *
   * A separate question from `next`, and the one people actually care about once they are in the
   * running: the board itself only publishes the next place up, so this is the figure nobody can
   * read off the page. When we are second the two are the same total, and `firstIsNext` says so
   * — a message giving both would print the same number twice with two different framings.
   */
  first: { name: string; votes: number; toBeat: number; toTie: number } | null;
  firstIsNext: boolean;
  /** Who is closest behind, and by how much. The half of the question nobody asks until it is lost. */
  chaser: { name: string; votes: number; lead: number } | null;
};

let cached: { at: number; reading: Reading } | null = null;

/** Cleared by the dashboard after a manual refresh, so a page reload is not served the memo. */
export const forget = (): void => {
  cached = null;
};

export const configured = (): boolean => config.leaderboard() !== null;

/**
 * The site as a person would open it. Handed out with an announcement, because a standing
 * without the place to go and vote is a notification nobody can act on.
 */
export const siteUrl = (): string | null => config.leaderboard()?.url ?? null;

/** Where a vote is actually cast, when the deployment knows. Usually not the board itself. */
export const voteUrl = (): string | null => config.leaderboard()?.voteUrl ?? null;

export const read = async (): Promise<Reading> => {
  const cfg = config.leaderboard();
  if (!cfg) throw new Error("no leaderboard is configured on this deployment");

  const fresh = cached && Date.now() - cached.at < TTL_MS;
  if (fresh && cached) return cached.reading;

  const response = await fetch(`${cfg.url}${PATH}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`the leaderboard answered ${response.status}`);
  }

  const parsed = PayloadSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      "the leaderboard answered something I could not read — its format has probably changed",
    );
  }

  const at = parsed.data.updatedAt ? new Date(parsed.data.updatedAt) : null;
  const reading: Reading = {
    projects: parsed.data.projects,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
    live: parsed.data.live ?? true,
  };
  cached = { at: Date.now(), reading };
  return reading;
};

/** "Stegora", or "Stegora y 2 más" when several share the total that has to be passed. */
const nameOf = (group: Project[]): string =>
  group.length === 1
    ? (group[0] as Project).name
    : `${(group[0] as Project).name} y ${group.length - 1} más`;

/**
 * Pure, and the reason it is pure is that it is the part worth testing.
 *
 * `null` when the slug is not on the board at all — a project withdrawn, a typo in the
 * configuration, or a board that has not opened yet. The caller says so rather than guessing.
 */
export const standing = (projects: Project[], slug: string): Standing | null => {
  const me = projects.find((p) => p.slug === slug);
  if (!me) return null;

  const ahead = projects.filter((p) => p.votes > me.votes);
  const behind = projects.filter((p) => p.votes < me.votes);

  /*
   * Ties share a position, so the position is a count of who is strictly ahead — not an index
   * into a sorted list. On the current board that makes Aegis thirteenth with one vote, behind
   * twelve projects, two of which are themselves tied for eleventh.
   */
  const position = 1 + ahead.length;
  const shared = projects.some((p) => p.slug !== me.slug && p.votes === me.votes);

  const nextVotes = ahead.length ? Math.min(...ahead.map((p) => p.votes)) : null;
  const blockers = nextVotes === null ? [] : projects.filter((p) => p.votes === nextVotes);

  const chaserVotes = behind.length ? Math.max(...behind.map((p) => p.votes)) : null;
  const chasers = chaserVotes === null ? [] : projects.filter((p) => p.votes === chaserVotes);

  /*
   * First place is the same shape of sum as the next place, against the top total instead of the
   * one immediately above — including the tie rule, since a first place shared by two has to be
   * beaten by more than both. When nobody is ahead of us, we are it.
   */
  const topVotes = Math.max(...projects.map((p) => p.votes));
  const leaders = projects.filter((p) => p.votes === topVotes);
  const atTop = me.votes === topVotes;

  return {
    me,
    position,
    shared,
    of: projects.length,
    totalVotes: projects.reduce((sum, p) => sum + p.votes, 0),
    next:
      nextVotes === null
        ? null
        : {
            name: nameOf(blockers),
            votes: nextVotes,
            // Strictly more than theirs takes the position; equalling it shares it.
            toBeat: nextVotes - me.votes + 1,
            toTie: nextVotes - me.votes,
          },
    first: atTop
      ? null
      : {
          name: nameOf(leaders),
          votes: topVotes,
          toBeat: topVotes - me.votes + 1,
          toTie: topVotes - me.votes,
        },
    firstIsNext: !atTop && nextVotes === topVotes,
    chaser:
      chaserVotes === null
        ? null
        : { name: nameOf(chasers), votes: chaserVotes, lead: me.votes - chaserVotes },
  };
};

/**
 * Whether the numbers can be presented as current.
 *
 * A feed that is down and a row that did not refresh are both "this is the last thing I know",
 * and reporting either as the score right now is the quiet way this feature becomes wrong.
 */
export const isCurrent = (standing: Standing, reading: Reading): boolean =>
  reading.live && standing.me.stale !== true;

const clock = (at: Date): string =>
  new Intl.DateTimeFormat("es-PE", {
    timeZone: config.timezone(),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);

const asOf = (standing: Standing, reading: Reading): string => {
  if (isCurrent(standing, reading)) return "";
  return reading.at ? ` (última lectura ${clock(reading.at)})` : " (lectura no actualizada)";
};

/**
 * What the model is handed.
 *
 * English and terse, like every other tool result here: it is read by a model that will render
 * it in whatever language the group is speaking. The arithmetic is done — the instruction not
 * to redo it is part of the payload, because a model given three numbers will subtract them.
 */
export const summary = (standing: Standing, reading: Reading): string => {
  const { me, next, chaser } = standing;
  const lines = [
    `${me.name}: ${me.votes} votes, position #${standing.position}${
      standing.shared ? " (shared)" : ""
    } of ${standing.of} projects. ${standing.totalVotes} votes cast in total.`,
  ];

  if (next) {
    lines.push(
      `To move up: ${next.toBeat} more votes passes ${next.name}, who has ${next.votes}. ${next.toTie} would draw level and share the position.`,
    );
  } else {
    lines.push("Already first — there is no position above this one.");
  }

  /*
   * First place is the figure nobody can read off the board, which only publishes the next place
   * up. Suppressed when we are second and it would be the same number twice.
   */
  if (standing.first && !standing.firstIsNext) {
    lines.push(
      `For first place: ${standing.first.toBeat} more votes passes ${standing.first.name}, who leads on ${standing.first.votes}.`,
    );
  }

  if (chaser) {
    lines.push(`${chaser.name} is next below on ${chaser.votes}, a lead of ${chaser.lead}.`);
  }

  if (!isCurrent(standing, reading)) {
    lines.push(
      `These figures are NOT current${
        reading.at ? ` — the feed last refreshed at ${clock(reading.at)}` : ""
      }. Say so when you report them.`,
    );
  }

  lines.push(
    "These numbers are already correct. Report them as they are — do not recompute the gap, and never state a figure that is not here.",
  );
  if (siteUrl()) lines.push(`The board is at ${siteUrl()}.`);

  return lines.join("\n");
};

/**
 * How the race looks, in words rather than in figures.
 *
 * This is what gets handed to whatever writes the closing line — including a model, which is
 * given the *situation* and never the numbers. "Ya casi" is a lie at three hundred votes and the
 * only thing worth saying at four, so the shape of the race has to reach the writer; the
 * arithmetic does not, and cannot then be restated wrongly.
 */
export type Situation =
  | "photo-finish"
  | "within-reach"
  | "a-long-way"
  | "leading-safe"
  | "leading-chased";

export const situation = (standing: Standing): Situation => {
  const { next, chaser } = standing;
  if (!next) return chaser && chaser.lead <= 15 ? "leading-chased" : "leading-safe";
  if (next.toBeat <= 5) return "photo-finish";
  if (next.toBeat <= 25) return "within-reach";
  return "a-long-way";
};

/**
 * The written-in lines, and the reason there are several of each.
 *
 * A scheduled message that ends the same way twice a day for a week stops being read at all —
 * people learn the shape of it and skip to the number. So one is picked at random per send.
 *
 * These are the *fallback*: the runner normally has a model write this line in the voice the bot
 * actually uses in that group, which is the only way it sounds like the same bot people talk to.
 * When that is unavailable or comes back unusable, these go out instead — an announcement must
 * never fail for want of a closing flourish.
 */
const CHEERS: Record<Situation, string[]> = {
  "photo-finish": [
    "Esto se decide ahora, en serio.",
    "Un puñado de votos y cambiamos de puesto.",
    "Estamos pegaditos. Ahora o nunca.",
  ],
  "within-reach": [
    "Está al alcance si nos movemos.",
    "Un empujón de grupo y pasamos.",
    "Falta poco, y poco se consigue rápido.",
  ],
  "a-long-way": [
    "Cada voto cuenta y toma diez segundos.",
    "Toma menos que leer este mensaje.",
    "Diez segundos, y ayuda más de lo que parece.",
    "Si no has votado, es el momento.",
  ],
  "leading-safe": [
    "Vamos primeros. A defenderlo.",
    "Primeros, y así se queda.",
    "Arriba. No aflojemos.",
  ],
  "leading-chased": [
    "Primeros, pero nos están pisando.",
    "No se suelta ahora.",
    "Vamos arriba y viene gente atrás.",
  ],
};

/** One of the written-in lines. `pick` is injectable so a check can pin the choice. */
export const cheerFor = (standing: Standing, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string => {
  const pool = CHEERS[situation(standing)];
  return pool[pick(pool.length)] ?? (pool[0] as string);
};

/**
 * A closing line is only allowed to carry encouragement, never a figure.
 *
 * The whole reason a model may write this at all is that it cannot be wrong here: the numbers
 * are already in the message, produced by arithmetic, and a line with a digit in it is a second
 * claim nobody checked. Rejected rather than repaired — the written-in pool is right there.
 */
export const usableCheer = (line: string): string | null => {
  const clean = line.trim().replace(/^["“'‘]|["”'’]$/g, "").trim();
  if (!clean) return null;
  if (/\d/.test(clean)) return null;
  if (/\n/.test(clean)) return null;
  if (/https?:|www\./i.test(clean)) return null;
  if (clean.length > 140) return null;
  return clean;
};

/**
 * The scheduled announcement, ready to send.
 *
 * Written once in Spanish rather than composed by a model. There is nobody to mirror in an
 * unprompted push, the sentence is arithmetic, and a model in this path could only add cost and
 * the chance of a wrong number. `*bold*` is the only formatting WhatsApp renders.
 */
export const announcement = (
  standing: Standing,
  reading: Reading,
  /** A closing line written elsewhere — normally in the bot's own voice. Falls back to the pool. */
  closing?: string | null,
): string => {
  const { me, next, chaser } = standing;
  const head = `*${me.name}* · #${standing.position}${standing.shared ? " (empatado)" : ""} de ${
    standing.of
  } · ${me.votes} votos${asOf(standing, reading)}`;

  const { first, firstIsNext } = standing;

  /*
   * Two questions, and second place is where they collapse into one. Printing "23 to pass PLUMB"
   * and "23 for first place" as separate lines is the same number twice with two framings, which
   * reads as a mistake even though both are true.
   */
  const gap = next
    ? firstIsNext
      ? `Faltan *${next.toBeat}* votos para el *primer puesto* (${next.name}, ${next.votes}).`
      : `Faltan *${next.toBeat}* votos para pasar a ${next.name} (${next.votes}).`
    : `Van *primeros*${chaser ? `, ${chaser.lead} votos por delante de ${chaser.name}` : ""}.`;

  const toFirst =
    first && !firstIsNext
      ? `Para el *primer puesto*: *${first.toBeat}* votos (${first.name}, ${first.votes}).`
      : "";

  const tail =
    next && chaser
      ? `${chaser.name} viene ${chaser.lead} ${chaser.lead === 1 ? "voto" : "votos"} atrás.`
      : "";
  const url = siteUrl();

  /*
   * Assembled as blocks rather than as lines, because the first version filtered empties out of
   * one flat list — which dropped the blank separators along with the optional lines and ran the
   * whole thing together. Nothing typechecks that; it has to be read, or asserted.
   */
  /*
   * The board's own address is dropped when there is a vote link: two URLs in one message is a
   * choice nobody wants to make, and the one that matters is the one where you vote. The picture
   * above the caption is already the board.
   */
  const tailUrl = voteUrl() ? null : url;

  const cheer = (closing && usableCheer(closing)) || cheerFor(standing);
  const link = voteUrl();

  /*
   * "Voten", not "Votá". The latter is vos — Argentina and Uruguay — and singular besides, so it
   * was wrong twice over for a group and doubly wrong beside a line written in Limeño. `ustedes`
   * is how you address a room anywhere in Latin America.
   */

  const blocks = [
    head,
    [gap, toFirst, tail].filter(Boolean).join("\n"),
    link ? `${cheer}\nVoten acá 👇\n${link}` : cheer,
    tailUrl ?? "",
  ];
  return blocks.filter(Boolean).join("\n\n");
};

/**
 * ── Watched groups ───────────────────────────────────────────────────────────────────────────
 *
 * A group told when the standing moves. Scheduling lives here and on the dashboard, and there is
 * deliberately no tool for it: the watch is per *chat*, not per person, so one person switching
 * it on commits the whole room to recurring notifications. Same reasoning as chime-ins and as
 * `lib/transfer.ts` — asking is a question anyone may ask; subscribing a room is not.
 */

export type Snapshot = { position: number; votes: number; gap: number | null };

export type Watch = {
  chat: string;
  chatName: string | null;
  enabled: boolean;
  cron: string;
  quietFrom: number;
  quietTo: number;
  maxPerDay: number;
  onChangeOnly: boolean;
  /** Attach a picture of the board to the message. The figures never come from it. */
  withPicture: boolean;
  /** How to sound here, in a person's own words. Steers the closing line; empty means no steer. */
  note: string | null;
  endsAt: Date | null;
  /** What the last announcement said. `null` until one has gone out. */
  last: Snapshot | null;
  announcedToday: number;
  /** Closing lines already used here, newest first. Kept so the next one can differ. */
  recentCheers: string[];
  lastRunAt: Date | null;
  lastError: string | null;
};

export const DEFAULTS = {
  /** Ten minutes is a ceiling, not a timer: with `onChangeOnly` it speaks far less often. */
  cron: "*/10 * * * *",
  quietFrom: 23,
  quietTo: 8,
  maxPerDay: 6,
  onChangeOnly: true,
  withPicture: true,
};

type WatchRow = {
  chat: string;
  chat_name: string | null;
  enabled: boolean;
  cron: string;
  quiet_from: number;
  quiet_to: number;
  max_per_day: number;
  on_change_only: boolean;
  with_picture: boolean;
  note: string | null;
  ends_at: Date | null;
  last_position: number | null;
  last_votes: number | null;
  last_gap: number | null;
  announced_day: string | null;
  announced_count: number;
  recent_cheers: string | null;
  last_run_at: Date | null;
  last_error: string | null;
};

const WATCH_COLUMNS =
  "chat, chat_name, enabled, cron, quiet_from, quiet_to, max_per_day, on_change_only, with_picture, note, ends_at, last_position, last_votes, last_gap, announced_day, announced_count, recent_cheers, last_run_at, last_error";

const toWatch = (row: WatchRow, at: Date): Watch => ({
  chat: row.chat,
  chatName: row.chat_name,
  enabled: row.enabled,
  cron: row.cron,
  quietFrom: Number(row.quiet_from),
  quietTo: Number(row.quiet_to),
  maxPerDay: Number(row.max_per_day),
  onChangeOnly: row.on_change_only,
  withPicture: row.with_picture,
  note: row.note?.trim() || null,
  endsAt: row.ends_at,
  last:
    row.last_position === null || row.last_votes === null
      ? null
      : {
          position: Number(row.last_position),
          votes: Number(row.last_votes),
          gap: row.last_gap === null ? null : Number(row.last_gap),
        },
  // A count from another day is not this day's count, and the row is not rewritten until a send.
  announcedToday: row.announced_day === dayKey(at) ? Number(row.announced_count) : 0,
  recentCheers: (row.recent_cheers ?? "").split("\n").filter(Boolean),
  lastRunAt: row.last_run_at,
  lastError: row.last_error,
});

export const list = async (at = new Date()): Promise<Watch[]> => {
  const rows = await query<WatchRow>(
    `select ${WATCH_COLUMNS} from leaderboard_watch order by chat`,
  );
  return rows.map((row) => toWatch(row, at));
};

export const forChat = async (chat: string, at = new Date()): Promise<Watch | null> => {
  const rows = await query<WatchRow>(
    `select ${WATCH_COLUMNS} from leaderboard_watch where chat = $1`,
    [chat],
  );
  const row = rows[0];
  return row ? toWatch(row, at) : null;
};

const hour = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23
    ? (value as number)
    : fallback;

export type WatchInput = {
  chat: string;
  chatName?: string | null;
  cron?: string;
  quietFrom?: number;
  quietTo?: number;
  maxPerDay?: number;
  onChangeOnly?: boolean;
  withPicture?: boolean;
  note?: string | null;
  endsAt?: Date | null;
};

/**
 * Upsert, because the dashboard's one form both adds and adjusts. The snapshot is deliberately
 * not touched: changing the cadence of a watch is not a reason to re-announce a standing that
 * has not moved.
 */
export const save = async (input: WatchInput): Promise<void> => {
  const pattern = (input.cron ?? DEFAULTS.cron).trim();
  const valid = cron.validate(pattern);
  if (!valid.ok) throw new Error(`cron: ${valid.error}`);

  await query(
    `insert into leaderboard_watch
       (chat, chat_name, cron, quiet_from, quiet_to, max_per_day, on_change_only, with_picture, note, ends_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (chat) do update set
       chat_name      = coalesce(excluded.chat_name, leaderboard_watch.chat_name),
       cron           = excluded.cron,
       quiet_from     = excluded.quiet_from,
       quiet_to       = excluded.quiet_to,
       max_per_day    = excluded.max_per_day,
       on_change_only = excluded.on_change_only,
       with_picture   = excluded.with_picture,
       note           = excluded.note,
       ends_at        = excluded.ends_at,
       last_error     = null`,
    [
      input.chat,
      input.chatName ?? null,
      pattern,
      hour(input.quietFrom, DEFAULTS.quietFrom),
      hour(input.quietTo, DEFAULTS.quietTo),
      Math.min(Math.max(input.maxPerDay ?? DEFAULTS.maxPerDay, 1), 48),
      input.onChangeOnly ?? DEFAULTS.onChangeOnly,
      input.withPicture ?? DEFAULTS.withPicture,
      input.note?.trim() || null,
      input.endsAt ?? null,
    ],
  );
};

export const setEnabled = (chat: string, on: boolean): Promise<unknown[]> =>
  query("update leaderboard_watch set enabled = $2 where chat = $1", [chat, on]);

export const remove = (chat: string): Promise<unknown[]> =>
  query("delete from leaderboard_watch where chat = $1", [chat]);

/**
 * Why this group is not about to be told anything.
 *
 * The same function the dashboard renders, so what somebody reads there is exactly what the
 * runner decided — "enabled and silent" is the normal state for a watch, and a page showing only
 * a switch would look broken.
 *
 * A pure function of the row and the clock, deliberately: whether this deployment has a board
 * configured at all is the caller's business, not this row's, and keeping it out is what lets
 * `npm run leaderboard-check` assert every one of these reasons without an environment.
 */
export const holdReason = (watch: Watch, at: Date): string | null => {
  if (!watch.enabled) return "switched off";
  if (watch.endsAt && watch.endsAt.getTime() <= at.getTime()) {
    return `the vote ended ${watch.endsAt.toISOString().slice(0, 10)}`;
  }
  if (quiet(watch.quietFrom, watch.quietTo, localHour(at))) {
    return `quiet hours (${watch.quietFrom}:00–${watch.quietTo}:00)`;
  }
  if (watch.announcedToday >= watch.maxPerDay) {
    return `today's limit of ${watch.maxPerDay} is used up`;
  }
  return null;
};

/** Does this minute match the pattern? A pattern that stopped parsing holds rather than throws. */
export const dueNow = (watch: Watch, at: Date): boolean => {
  try {
    return cron.matches(cron.parse(watch.cron), at, config.timezone());
  } catch {
    return false;
  }
};

/**
 * Take this minute for this chat.
 *
 * The guard is the update, not a read before it: two ticks in the same minute — an overlapping
 * timer, a restart, a second container — cannot both come back true. Same lease as
 * `summaries.claimDue`, and it moves whether or not anything is ultimately said, because it
 * means "this minute has been considered".
 */
export const claim = async (chat: string, at: Date): Promise<boolean> => {
  const key = cron.minuteKey(at, config.timezone());
  const claimed = await query<{ chat: string }>(
    `update leaderboard_watch
        set last_minute = $2, last_run_at = now()
      where chat = $1 and (last_minute is distinct from $2)
      returning chat`,
    [chat, key],
  );
  return claimed.length > 0;
};

/**
 * Written down only after a message has actually gone out.
 *
 * This is the reminder bug one table over: if the snapshot moved when the standing was *read*,
 * a send that failed would leave the row looking announced, and the one change anybody cared
 * about is the one nobody hears.
 */
/** How many past closing lines to keep. Enough to stop a rotation, short enough to stay a hint. */
const CHEERS_REMEMBERED = 6;

export const markAnnounced = (
  chat: string,
  standing: Standing,
  at: Date,
  /** The closing line that went out, so the next one can be told not to repeat it. */
  cheer?: string | null,
): Promise<unknown[]> =>
  query(
    `update leaderboard_watch
        set last_position   = $2,
            last_votes      = $3,
            last_gap        = $4,
            announced_day   = $5,
            announced_count = case when announced_day = $5 then announced_count + 1 else 1 end,
            recent_cheers   = case
                                when $6::text is null then recent_cheers
                                else array_to_string(
                                       (array[$6::text] || string_to_array(coalesce(recent_cheers, ''), E'\n'))[1:${CHEERS_REMEMBERED}],
                                       E'\n')
                              end,
            last_error      = null
      where chat = $1`,
    [chat, standing.position, standing.me.votes, standing.next?.toBeat ?? null, dayKey(at), cheer ?? null],
  );

export const markFailed = (chat: string, error: string): Promise<unknown[]> =>
  query("update leaderboard_watch set last_error = $2 where chat = $1", [
    chat,
    error.slice(0, 500),
  ]);

/**
 * Has anything happened worth a notification?
 *
 * A watch that speaks on every firing is a watch a group mutes, so by default only a real change
 * goes out: the place, the votes, or the size of the gap.
 *
 * It used to also return a headline — "Subimos al #3 (estábamos #4)" — which read well and was
 * cut on request: the standing line right underneath already says the place, and a group watching
 * a vote knows which way it moved without being told twice.
 */
export const movement = (previous: Snapshot | null, standing: Standing): { changed: boolean } => {
  if (!previous) return { changed: true };
  if (standing.position !== previous.position) return { changed: true };
  const gap = standing.next?.toBeat ?? null;
  if (standing.me.votes !== previous.votes || gap !== previous.gap) return { changed: true };
  return { changed: false };
};
