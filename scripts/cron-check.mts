/**
 * The cron evaluator, against real dates in real timezones.
 *
 * Worth its own script because every bug here is silent: a summary that fires at the wrong hour,
 * twice, or never, looks exactly like a summary nobody scheduled. The daylight-saving cases are
 * the ones no amount of reading catches — they need actual dates on actual transition days.
 *
 * Needs no keys and no database.
 *
 *   npm run cron-check
 */

import { parse, matches, validate, minuteKey, nextRuns, wallClock } from "../lib/cron.js";

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    pass ? "  PASS" : "  FAIL",
    label,
    pass ? "" : `— got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`,
  );
};

/** A date written the way a person would say it, in UTC. */
const utc = (s: string) => new Date(`${s}Z`);

console.log("\nparsing:");
check("a plain daily pattern is valid", validate("0 9 * * *").ok, true);
check("five fields are required", validate("0 9 * *").ok, false);
check("a minute over 59 is refused", validate("60 9 * * *").ok, false);
check("an hour over 23 is refused", validate("0 24 * * *").ok, false);
check("a backwards range is refused", validate("0 17-9 * * *").ok, false);
check("a zero step is refused", validate("*/0 * * * *").ok, false);
check("nonsense is refused", validate("every morning please").ok, false);
check("a step is valid", validate("*/15 * * * *").ok, true);
check("a list is valid", validate("0 9,13,18 * * *").ok, true);
check("a range with a step is valid", validate("0 9-17/2 * * 1-5").ok, true);
check("sunday spelled 7 is valid", validate("0 9 * * 7").ok, true);

console.log("\nfield expansion:");
check("*/15 gives four minutes", [...parse("*/15 * * * *").minute], [0, 15, 30, 45]);
check("9-17/4 gives three hours", [...parse("0 9-17/4 * * *").hour], [9, 13, 17]);
check("a list keeps its members", [...parse("0 9,13,18 * * *").hour], [9, 13, 18]);
check("7 folds onto sunday", [...parse("0 9 * * 7").dayOfWeek], [0]);
// A bare number with a step reads as "from here to the end of the field".
check("30/10 runs to the end of the hour", [...parse("30/10 * * * *").minute], [30, 40, 50]);

console.log("\nmatching (UTC):");
const nine = parse("0 9 * * *");
check("fires at 09:00", matches(nine, utc("2026-03-10T09:00:00"), "UTC"), true);
check("not at 09:01", matches(nine, utc("2026-03-10T09:01:00"), "UTC"), false);
check("not at 08:00", matches(nine, utc("2026-03-10T08:00:00"), "UTC"), false);

const weekdays = parse("30 8 * * 1-5");
// 2026-08-24 is a Monday; the 29th is a Saturday.
check("weekday pattern fires on Monday", matches(weekdays, utc("2026-08-24T08:30:00"), "UTC"), true);
check("weekday pattern skips Saturday", matches(weekdays, utc("2026-08-29T08:30:00"), "UTC"), false);

/**
 * The union rule: with both day fields restricted, either one firing is enough. Getting this
 * backwards turns "the 13th or any Friday" into "Friday the 13th", which fires almost never.
 */
console.log("\nthe day-of-month / day-of-week union:");
const union = parse("0 9 13 * 5");
check("fires on the 13th (a Thursday)", matches(union, utc("2026-08-13T09:00:00"), "UTC"), true);
check("fires on a Friday that is not the 13th", matches(union, utc("2026-08-14T09:00:00"), "UTC"), true);
check("does not fire on a Tuesday the 11th", matches(union, utc("2026-08-11T09:00:00"), "UTC"), false);
const domOnly = parse("0 9 13 * *");
check("with only the day-of-month set, other days do not fire", matches(domOnly, utc("2026-08-14T09:00:00"), "UTC"), false);

console.log("\ntimezones:");
const lima = parse("0 9 * * *");
// Lima is UTC-5 all year — no daylight saving, so this is the simple case.
check("09:00 in Lima is 14:00 UTC", matches(lima, utc("2026-08-24T14:00:00"), "America/Lima"), true);
check("and not 09:00 UTC", matches(lima, utc("2026-08-24T09:00:00"), "America/Lima"), false);

/**
 * Daylight saving, which is the whole reason this asks "does now match?" instead of computing
 * the next occurrence. On 2026-03-29 Madrid jumps from 02:00 to 03:00; on 2026-10-25 it repeats
 * 02:00-03:00. A 09:00 job must fire exactly once on both days, at 09:00 local either way.
 */
console.log("\ndaylight saving (Europe/Madrid):");
const madrid = parse("0 9 * * *");
check(
  "spring forward: 09:00 local is 07:00 UTC",
  matches(madrid, utc("2026-03-29T07:00:00"), "Europe/Madrid"),
  true,
);
check(
  "autumn back: 09:00 local is 08:00 UTC",
  matches(madrid, utc("2026-10-25T08:00:00"), "Europe/Madrid"),
  true,
);
const perDay = (day: string, tz: string) => {
  let hits = 0;
  for (let m = 0; m < 60 * 24; m++) {
    if (matches(madrid, new Date(utc(`${day}T00:00:00`).getTime() + m * 60_000), tz)) hits++;
  }
  return hits;
};
check("fires exactly once on the short day", perDay("2026-03-29", "Europe/Madrid"), 1);
check("fires exactly once on the long day", perDay("2026-10-25", "Europe/Madrid"), 1);
check("fires exactly once on an ordinary day", perDay("2026-08-24", "Europe/Madrid"), 1);

console.log("\nmidnight:");
const midnight = parse("0 0 * * *");
check("00:00 matches", matches(midnight, utc("2026-08-24T00:00:00"), "UTC"), true);
check("hour reads as 0, not 24", wallClock(utc("2026-08-24T00:00:00"), "UTC").hour, 0);

console.log("\nthe firing key:");
check(
  "two ticks in the same minute share a key",
  minuteKey(utc("2026-08-24T09:00:10"), "UTC") === minuteKey(utc("2026-08-24T09:00:50"), "UTC"),
  true,
);
check(
  "the next minute does not",
  minuteKey(utc("2026-08-24T09:00:10"), "UTC") === minuteKey(utc("2026-08-24T09:01:10"), "UTC"),
  false,
);
check(
  "the key is local, so two zones differ",
  minuteKey(utc("2026-08-24T09:00:00"), "UTC") === minuteKey(utc("2026-08-24T09:00:00"), "America/Lima"),
  false,
);

console.log("\npreview:");
const runs = nextRuns(parse("0 9 * * *"), "UTC", 3, utc("2026-08-24T10:00:00"));
check("three runs are returned", runs.length, 3);
check("the first is tomorrow at 09:00", runs[0]?.toISOString(), "2026-08-25T09:00:00.000Z");
check("they are a day apart", runs[2]!.getTime() - runs[0]!.getTime(), 2 * 24 * 3600 * 1000);
// A pattern that cannot occur inside the scan window returns nothing rather than hanging.
check("an unreachable pattern returns none", nextRuns(parse("0 9 30 2 *"), "UTC", 1).length, 0);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
