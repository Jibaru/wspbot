/**
 * Just enough cron to schedule a summary.
 *
 * Five fields — minute, hour, day-of-month, month, day-of-week — with `*`, numbers, `a-b`
 * ranges, `,` lists and `/n` steps. No seconds field, no `@daily`, no `L`/`W`/`#`.
 *
 * The design decision worth knowing: this answers **"does the current minute match?"** rather
 * than "when does it next fire?". A tick every minute plus a record of the last minute fired is
 * the whole scheduler, which sidesteps the part of cron that is genuinely hard — computing the
 * next occurrence across a daylight-saving boundary in an arbitrary timezone. Wall-clock fields
 * are read straight out of `Intl.DateTimeFormat`, so "09:00 in Lima" means exactly that on both
 * sides of a transition.
 *
 * No `server-only`: `npm run cron-check` imports it directly.
 */

export type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /**
   * Vixie cron's oddest rule, and the one that surprises people: when *both* day-of-month and
   * day-of-week are restricted, a day matching **either** fires. Restricting only one ANDs
   * normally. `0 9 13 * 5` is the 13th *or* any Friday, not Friday the 13th.
   */
  dayIsUnion: boolean;
};

const RANGES: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

const field = (raw: string, name: keyof typeof RANGES): Set<number> => {
  const [lo, hi] = RANGES[name]!;
  const out = new Set<number>();

  for (const part of raw.split(",")) {
    const [spec, stepRaw] = part.split("/");
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) {
      throw new Error(`${name}: "${part}" has a bad step`);
    }
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw new Error(`${name}: step must be at least 1`);

    let from: number;
    let to: number;
    if (spec === "*" || spec === "") {
      from = lo;
      to = hi;
    } else if (/^\d+$/.test(spec!)) {
      from = Number(spec);
      // A bare number with a step means "from here to the end", as cron has always read it.
      to = stepRaw === undefined ? from : hi;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(spec!);
      if (!m) throw new Error(`${name}: cannot read "${part}"`);
      from = Number(m[1]);
      to = Number(m[2]);
    }

    // Sunday is 0, and 7 is the same Sunday — both spellings are in the wild.
    if (name === "dayOfWeek") {
      if (from === 7) from = 0;
      if (to === 7) to = 0;
    }
    if (from < lo || from > hi || to < lo || to > hi) {
      throw new Error(`${name}: "${part}" is outside ${lo}-${hi}`);
    }
    if (from > to) throw new Error(`${name}: "${part}" runs backwards`);

    for (let v = from; v <= to; v += step) out.add(v);
  }

  if (out.size === 0) throw new Error(`${name}: matches nothing`);
  return out;
};

export const parse = (pattern: string): Cron => {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: field(minute, "minute"),
    hour: field(hour, "hour"),
    dayOfMonth: field(dayOfMonth, "dayOfMonth"),
    month: field(month, "month"),
    dayOfWeek: field(dayOfWeek, "dayOfWeek"),
    dayIsUnion: dayOfMonth !== "*" && dayOfWeek !== "*",
  };
};

/** `true` when the pattern is usable; the message is what to show someone who typed it. */
export const validate = (pattern: string): { ok: true } | { ok: false; error: string } => {
  try {
    parse(pattern);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type WallClock = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

/**
 * The wall clock in one timezone, as cron fields.
 *
 * Via `Intl` rather than arithmetic on the epoch, because that is what makes offsets and
 * daylight saving somebody else's problem — and it is the same mechanism `lib/reminders.ts`
 * already uses to tell the model what time it is.
 */
export const wallClock = (at: Date, timeZone: string): WallClock => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  return {
    minute: Number(get("minute")),
    // Midnight formats as 24 in some locales' hour-cycle handling; cron calls it 0.
    hour: Number(get("hour")) % 24,
    dayOfMonth: Number(get("day")),
    month: Number(get("month")),
    dayOfWeek: WEEKDAYS[get("weekday")] ?? 0,
  };
};

export const matches = (cron: Cron, at: Date, timeZone: string): boolean => {
  const now = wallClock(at, timeZone);

  if (!cron.minute.has(now.minute)) return false;
  if (!cron.hour.has(now.hour)) return false;
  if (!cron.month.has(now.month)) return false;

  const dom = cron.dayOfMonth.has(now.dayOfMonth);
  const dow = cron.dayOfWeek.has(now.dayOfWeek);
  return cron.dayIsUnion ? dom || dow : dom && dow;
};

/**
 * The minute a firing belongs to, in the schedule's own timezone.
 *
 * Stored against the schedule so a tick that runs twice in the same minute — a restart, an
 * overlapping timer — cannot send the same summary twice. Comparing wall-clock minutes rather
 * than timestamps is what makes that true across a clock change as well.
 */
export const minuteKey = (at: Date, timeZone: string): string => {
  const w = wallClock(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(w.month)}-${pad(w.dayOfMonth)}T${pad(w.hour)}:${pad(w.minute)}`;
};

/**
 * The next few firings, for showing someone that the pattern they typed does what they meant.
 *
 * A forward scan a minute at a time rather than arithmetic: the same "does this minute match?"
 * test as the scheduler, so the preview cannot disagree with the behaviour. Bounded at 40 days,
 * which is past any pattern worth previewing.
 */
export const nextRuns = (
  cron: Cron,
  timeZone: string,
  count = 3,
  from: Date = new Date(),
): Date[] => {
  const out: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const LIMIT = 60 * 24 * 40;
  for (let i = 0; i < LIMIT && out.length < count; i++) {
    if (matches(cron, cursor, timeZone)) out.push(new Date(cursor.getTime()));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
};
