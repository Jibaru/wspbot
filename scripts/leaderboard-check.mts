/**
 * The gap arithmetic, and whether it agrees with the board itself.
 *
 * This feature is one subtraction, and that subtraction is an off-by-one with a plausible wrong
 * answer. Ties share a position, so "the next place" is not the row above in the list: on the
 * current board eight projects sit on nought votes and are all seventeenth, and passing them
 * costs two votes, not one. A wrong number here is not a visible failure — it is the bot
 * confidently telling a room the wrong target, which nobody checks.
 *
 * So there are two halves. Fixtures pin the tie rules with no network at all. Then, when a board
 * is configured, the live one is read *twice* — the JSON and the page — and our arithmetic is
 * compared against the arithmetic the site prints for itself. Two independent implementations
 * agreeing is worth more than any assertion written here by hand.
 *
 *   npm run leaderboard-check
 */

import { readFileSync } from "node:fs";
import { config } from "../lib/config.js";
import { quiet, localHour } from "../lib/chime.js";
import * as cron from "../lib/cron.js";
import {
  standing,
  summary,
  announcement,
  read,
  movement,
  holdReason,
  situation,
  cheerFor,
  usableCheer,
  claim,
  markAnnounced,
  save,
  remove,
  forChat,
  dueNow,
  DEFAULTS,
  type Project,
  type Reading,
  type Watch,
} from "../lib/leaderboard.js";

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

const ok = (label: string, pass: boolean, why = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, pass ? "" : `— ${why}`);
};

/**
 * The real board as it stood when this was written, kept as a fixture so the tie rules are
 * pinned without a network. The tail is what matters: four projects on one vote, eight on none.
 */
const BOARD: Project[] = [
  { slug: "auxio", name: "AuXio", votes: 208 },
  { slug: "plumb", name: "PLUMB", votes: 146 },
  { slug: "cumplia", name: "complAI", votes: 114 },
  { slug: "stegora", name: "Stegora", votes: 83 },
  { slug: "woki", name: "WOKI", votes: 61 },
  { slug: "vity", name: "Vity", votes: 46 },
  { slug: "roxy", name: "Roxy", votes: 22 },
  { slug: "neuroecho", name: "NeuroEcho", votes: 9 },
  { slug: "hippocamp", name: "Hippocamp", votes: 5 },
  { slug: "hive", name: "HIVE", votes: 4 },
  { slug: "moirai", name: "Moirai", votes: 2 },
  { slug: "peaje", name: "Peaje", votes: 2 },
  { slug: "aegis", name: "Aegis", votes: 1 },
  { slug: "bus-factor-hq", name: "Bus Factor HQ", votes: 1 },
  { slug: "deleycom", name: "deley.com", votes: 1 },
  { slug: "replica", name: "Replica", votes: 1 },
  { slug: "dipia", name: "dipia", votes: 0 },
  { slug: "helius", name: "Helius", votes: 0 },
  { slug: "palante", name: "Pa'lante", votes: 0 },
  { slug: "parallax", name: "Parallax", votes: 0 },
  { slug: "provenance", name: "Provenance Firewall", votes: 0 },
  { slug: "pulse", name: "PULSE", votes: 0 },
  { slug: "pulso", name: "PULSO", votes: 0 },
  { slug: "temis", name: "TEMIS", votes: 0 },
];

const live: Reading = { projects: BOARD, at: new Date("2026-09-07T01:37:38Z"), live: true };

/** Defined as a call so the first-place block can use it before the ends-of-board section. */
const auxioFirst = () => standing(BOARD, "auxio");

console.log("\nthe board as read:");
const woki = standing(BOARD, "woki");
ok("woki is on the board", woki !== null, "the fixture lost its own project");
if (!woki) process.exit(1);

check("24 projects", woki.of, 24);
check("706 votes cast", woki.totalVotes, 706);
check("woki is fifth", woki.position, 5);
check("nobody shares fifth", woki.shared, false);
check("61 votes", woki.me.votes, 61);
check("the next place is Stegora's", woki.next?.name, "Stegora");
check("23 votes takes it", woki.next?.toBeat, 23);
check("22 draws level", woki.next?.toTie, 22);
check("Vity is behind by 15", woki.chaser, { name: "Vity", votes: 46, lead: 15 });

console.log("\nties share a position, which is where the off-by-one lives:");
/*
 * Twelve projects have more than one vote, so a project on one vote is thirteenth — not
 * sixteenth, which is what its index in a sorted list would say.
 */
const aegis = standing(BOARD, "aegis");
check("one vote is thirteenth, not sixteenth", aegis?.position, 13);
check("thirteenth is shared", aegis?.shared, true);
check("the next total up is 2, held by two projects", aegis?.next?.votes, 2);
check("both of them are named", aegis?.next?.name, "Moirai y 1 más");
check("passing them costs 2", aegis?.next?.toBeat, 2);
check("tying them costs 1", aegis?.next?.toTie, 1);

/*
 * The case a naive `list[i - 1]` gets wrong in the most convincing way: the row above a
 * nought-vote project is another nought-vote project, so "the next place" is neither the row
 * above nor one vote away.
 */
const dipia = standing(BOARD, "dipia");
check("nought votes is seventeenth", dipia?.position, 17);
check("the row above is not the next place", dipia?.next?.votes, 1);
check("four projects hold it", dipia?.next?.name, "Aegis y 3 más");
check("passing them costs 2, not 1", dipia?.next?.toBeat, 2);

console.log("\nfirst place is a different question from the next place:");
check("the leader is named", woki.first?.name, "AuXio");
check("and taking it costs more than the next place", woki.first?.toBeat, 208 - 61 + 1);
check("tying for it costs one less", woki.first?.toTie, 208 - 61);
check("from fifth, first is not the next place", woki.firstIsNext, false);

/*
 * From second the two questions collapse into one, and a message printing both would give the
 * same number twice with two framings — which reads as a mistake even though both are true.
 */
const second = standing(BOARD, "plumb");
check("from second, first place *is* the next place", second?.firstIsNext, true);
check("and it costs the same either way", second?.first?.toBeat, second?.next?.toBeat);
ok(
  "so the announcement says it once",
  (() => {
    const text = announcement(second!, live);
    return text.includes("primer puesto") && !text.includes("para pasar a");
  })(),
  announcement(second!, live),
);
check("the leader has no first place to chase", auxioFirst()?.first, null);

console.log("\nthe ends of the board:");
const auxio = standing(BOARD, "auxio");
check("first has no place above it", auxio?.next, null);
check("first is first", auxio?.position, 1);
check("and knows its lead", auxio?.chaser, { name: "PLUMB", votes: 146, lead: 62 });

const last = standing(BOARD, "temis");
check("last has nobody behind it", last?.chaser, null);
check("a project not on the board is not invented", standing(BOARD, "nope"), null);

console.log("\nwhat gets said:");
const said = announcement(woki, live);
ok("the announcement leads with the project", said.startsWith("*WOKI*"), said);
ok("the gap is in it, in bold", said.includes("*23*"), said);
ok("so is who has to be passed", said.includes("Stegora"), said);
ok("and it does not claim to be stale", !said.includes("lectura"), said);

ok(
  "the first-place figure is there too",
  said.includes("primer puesto") && said.includes(`*${208 - 61 + 1}*`),
  said,
);
/*
 * The layout, asserted because it is invisible to a typecheck and was wrong once: the first
 * version filtered empty strings out of one flat list of lines, which dropped the deliberate
 * blank separators along with the optional lines and ran the message together into a wall.
 *
 * The link block only exists when a board is configured, which it is not when this file runs
 * with no environment — so what is asserted is the separation, not a block count.
 */
const blocks = said.split("\n\n");
ok("the heading is its own block", blocks[0]?.includes("\n") === false, JSON.stringify(blocks[0]));
ok(
  "the figures are together in the next one",
  blocks[1]?.includes("Faltan") === true && blocks[1]?.includes("primer puesto") === true,
  JSON.stringify(blocks[1]),
);
check("with one line per figure", blocks[1]?.split("\n").length, 3);

const forModel = summary(woki, live);
ok("the model is told the numbers are done", forModel.includes("do not recompute"), forModel);
ok("and gets both figures", forModel.includes("23") && forModel.includes("22"), forModel);

/*
 * A feed that is down and a row that did not refresh are the same thing to a reader: this is the
 * last thing known, not the score now. Reporting either as current is the quiet way this becomes
 * wrong, so both paths have to say so.
 */
/*
 * The closing line is the one part of this message a model writes, and the only reason that is
 * allowed is that it cannot be wrong: the figures are already above it, so a line carrying a
 * number is a second claim nobody checked. Rejected, not repaired — the written-in pool is there.
 */
console.log("\nwhat a closing line is allowed to be:");
check("plain encouragement passes", usableCheer("Vayan a votar, no cuesta nada."), "Vayan a votar, no cuesta nada.");
check("surrounding quotes are stripped", usableCheer('"Voten pues"'), "Voten pues");
check("curly quotes too", usableCheer("\u201cVoten pues\u201d"), "Voten pues");
check("a digit is refused", usableCheer("Faltan 3 votos, vamos"), null);
check("so is a lone number", usableCheer("Ya casi, 300 y pasamos"), null);
check("a link is refused — one is added after it", usableCheer("Voten en https://x.com"), null);
check("so is a second line", usableCheer("Voten pues\ny cuenten a sus amigos"), null);
check("an empty answer is refused", usableCheer("   "), null);
check("a speech is refused", usableCheer("a".repeat(141)), null);
ok("140 characters is still fine", usableCheer("a".repeat(140)) !== null);

console.log("\nthe written-in pool, which is the fallback when no line can be had:");
// 23 votes off Stegora on the fixture board: close enough for the group to close it today.
check("it knows the shape of the race", situation(woki), "within-reach");
check(
  "a hopeless-looking gap is its own case",
  situation(standing([{ slug: "a", name: "A", votes: 900 }, { slug: "woki", name: "WOKI", votes: 60 }], "woki")!),
  "a-long-way",
);
check(
  "second place with a hair between them is a photo finish",
  situation(standing([{ slug: "a", name: "A", votes: 60 }, { slug: "woki", name: "WOKI", votes: 58 }], "woki")!),
  "photo-finish",
);
check(
  "leading with somebody breathing down our neck",
  situation(standing([{ slug: "woki", name: "WOKI", votes: 60 }, { slug: "a", name: "A", votes: 55 }], "woki")!),
  "leading-chased",
);
/*
 * More than one line per situation, because a scheduled message that ends the same way twice a
 * day is one people stop reading. `pick` is injected so this pins the pool rather than the dice.
 */
const drawn = new Set(
  Array.from({ length: 12 }, (_, i) => cheerFor(woki, (n) => i % n)),
);
ok(`the pool offers more than one line (${drawn.size} distinct)`, drawn.size > 1, "one line is a rotation of one");
ok("and every draw is usable", [...drawn].every((line) => usableCheer(line) !== null));

console.log("\na reading that is not current says so:");
const down = announcement(woki, { ...live, live: false });
ok("a dead feed is dated in the announcement", down.includes("última lectura"), down);
const staleRow = summary({ ...woki, me: { ...woki.me, stale: true } }, live);
ok("a stale row warns the model", staleRow.includes("NOT current"), staleRow);

/**
 * A watch is mostly restraint, and every piece of that restraint is a thing that goes wrong
 * silently: it either says nothing when it should, or says something at four in the morning.
 */
const watch = (over: Partial<Watch> = {}): Watch => ({
  chat: "check-only@g.us",
  chatName: "check",
  enabled: true,
  cron: DEFAULTS.cron,
  quietFrom: DEFAULTS.quietFrom,
  quietTo: DEFAULTS.quietTo,
  maxPerDay: DEFAULTS.maxPerDay,
  onChangeOnly: true,
  withPicture: true,
  note: null,
  endsAt: null,
  last: null,
  announcedToday: 0,
  recentCheers: [],
  lastRunAt: null,
  lastError: null,
  ...over,
});

console.log("\nwhat counts as movement:");
check("a first announcement always goes out", movement(null, woki).changed, true);
check("and it has no headline to compare against", movement(null, woki).headline, null);
check(
  "an unchanged board says nothing",
  movement({ position: 5, votes: 61, gap: 23 }, woki).changed,
  false,
);
check(
  "a closing gap is news even at the same place",
  movement({ position: 5, votes: 61, gap: 30 }, woki).changed,
  true,
);
check(
  "more votes at the same place is news",
  movement({ position: 5, votes: 40, gap: 23 }, woki).changed,
  true,
);
ok(
  "rising leads with the direction",
  movement({ position: 7, votes: 20, gap: 4 }, woki).headline?.includes("Subimos al #5") === true,
  JSON.stringify(movement({ position: 7, votes: 20, gap: 4 }, woki)),
);
ok(
  "being passed says so plainly",
  movement({ position: 3, votes: 61, gap: 1 }, woki).headline?.includes("Nos pasaron") === true,
  JSON.stringify(movement({ position: 3, votes: 61, gap: 1 }, woki)),
);

console.log("\nwhen a watch holds its tongue:");
/*
 * Quiet hours wrap around midnight, so 23->8 contains neither endpoint in the usual order.
 * Getting it backwards means messaging a group at four in the morning, which is the one failure
 * here nobody forgives.
 *
 * **Asserted on hours, not on dates.** The first version wrote UTC instants and asserted on the
 * wall-clock hour they land on, which passes under BOT_TIMEZONE=UTC and fails under
 * America/Lima — and this file loads .env when there is one, so it would have failed on the
 * first run for anybody whose deployment is not in UTC. A check that depends on the checker's
 * timezone is a check that reports the environment rather than the code.
 */
ok("04:00 is inside 23->8", quiet(23, 8, 4));
ok("23:00 is inside it, the start being inclusive", quiet(23, 8, 23));
ok("22:59's hour is outside it", !quiet(23, 8, 22));
ok("08:00 is outside it, the end being exclusive", !quiet(23, 8, 8));
ok("07:00 is inside it", quiet(23, 8, 7));
ok("the un-wrapped direction holds too", quiet(9, 17, 12));
ok("with the same edges", quiet(9, 17, 9) && !quiet(9, 17, 17));
ok("equal bounds mean never quiet", !quiet(8, 8, 8) && !quiet(8, 8, 20));

/*
 * And the plumbing: that `holdReason` really consults those hours against the bot's own clock.
 * Built relative to the current local hour so it means the same thing in any timezone.
 */
const nowAt = new Date();
const h = localHour(nowAt);
const around = (from: number, to: number) => watch({ quietFrom: from % 24, quietTo: to % 24 });

ok("a window starting this hour holds", holdReason(around(h, h + 9), nowAt) !== null);
ok("a window that ended this hour does not", holdReason(around(h + 22, h), nowAt) === null);
ok("a window later today does not", holdReason(around(h + 1, h + 2), nowAt) === null);
ok("no quiet hours at all does not", holdReason(around(h, h), nowAt) === null);

/*
 * Everything else about a hold, with the quiet window taken out of the picture — an assertion
 * about the daily cap must not depend on what time it is where the checker sits.
 */
const anyHour = (over: Partial<Watch>) => watch({ quietFrom: 0, quietTo: 0, ...over });

ok("switched off holds", holdReason(anyHour({ enabled: false }), nowAt) !== null);
ok(
  "a used-up daily cap holds",
  holdReason(anyHour({ announcedToday: 6, maxPerDay: 6 }), nowAt) !== null,
);
ok(
  "a cap from another day does not",
  holdReason(anyHour({ announcedToday: 0, maxPerDay: 6 }), nowAt) === null,
);
ok(
  "a finished vote holds forever after",
  holdReason(anyHour({ endsAt: new Date("2026-09-01T00:00:00Z") }), nowAt) !== null,
);
ok(
  "and does not hold before it ends",
  holdReason(anyHour({ endsAt: new Date("2099-01-01T00:00:00Z") }), nowAt) === null,
);

/*
 * The cadence. Only that `dueNow` consults the pattern against the bot's own clock and survives
 * a pattern that stopped parsing — the evaluator itself, daylight saving included, belongs to
 * `npm run cron-check` and is not re-tested here. Derived from the current minute so it does not
 * depend on the checker's timezone either.
 */
console.log("\nthe cadence:");
const wall = cron.wallClock(nowAt, config.timezone());
ok("a pattern naming this minute is due", dueNow(watch({ cron: `${wall.minute} * * * *` }), nowAt));
ok(
  "one naming the next minute is not",
  !dueNow(watch({ cron: `${(wall.minute + 1) % 60} * * * *` }), nowAt),
);
ok(
  "a pattern that stopped parsing holds rather than throwing",
  !dueNow(watch({ cron: "nonsense" }), nowAt),
);

/**
 * The live half. Two independent readings of the same board: the JSON we do arithmetic on, and
 * the page, which prints its own answer to the same question. If they disagree, one of us is
 * wrong and it matters which.
 */
/**
 * Does the schema actually have every column the code reads?
 *
 * This is the check that was missing when a column added to `create table if not exists` shipped
 * without an `add column if not exists` beside it. The create statement is a no-op on a table
 * that already exists, so the column reached a fresh database and never the running one — and
 * every check here verified the schema against an empty throwaway, which takes the create path
 * and passes. Production's first read of the table then failed on a missing column with all of
 * them green.
 *
 * Static, and reading the two real files rather than a list: `WATCH_COLUMNS` is what every query
 * selects, so a name in there with no home in the DDL is the exact shape of that outage. It does
 * not prove the migration runs — nothing but a database with the old table can — but it is free,
 * it needs no connection, and it catches the mismatch.
 */
console.log("\nthe schema and the columns the code reads:");
{
  const lib = readFileSync(new URL("../lib/leaderboard.ts", import.meta.url), "utf8");
  const ddl = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");

  const selected =
    /const WATCH_COLUMNS =\s*\n?\s*"([^"]+)"/.exec(lib)?.[1]?.split(",").map((c) => c.trim()) ?? [];
  ok(`WATCH_COLUMNS parsed (${selected.length} columns)`, selected.length > 5, "the pattern drifted from the source");

  const create = /create table if not exists leaderboard_watch \(([\s\S]*?)\n    \);/.exec(ddl)?.[1] ?? "";
  const created = new Set(
    [...create.matchAll(/^\s{6}([a-z_]+)\s+(?:text|boolean|integer|timestamptz)/gm)].map((m) => m[1] as string),
  );
  const altered = new Set(
    [...ddl.matchAll(/alter table leaderboard_watch add column if not exists\s+([a-z_]+)/g)].map((m) => m[1] as string),
  );
  ok(`the create statement was found (${created.size} columns)`, created.size > 5, "the pattern drifted from the DDL");

  const homeless = selected.filter((c) => !created.has(c));
  ok(
    `every selected column exists in the DDL${homeless.length ? "" : ` (${selected.length})`}`,
    homeless.length === 0,
    `${homeless.join(", ")} is selected and never created — this is the outage`,
  );

  /*
   * An alter for a column the create statement does not have is the other direction of the same
   * mistake: a fresh database would never get it.
   */
  const orphans = [...altered].filter((c) => !created.has(c));
  ok(
    `every migrated column is also in the create (${altered.size} migrated)`,
    orphans.length === 0,
    `${orphans.join(", ")} is altered in but never created`,
  );
}

const cfg = config.leaderboard();
if (!cfg) {
  console.log(
    "\nlive board: skipped — set LEADERBOARD_URL and LEADERBOARD_SLUG to check against the real one",
  );
} else {
  console.log(`\nlive board (${cfg.url}, as ${cfg.slug}):`);

  /*
   * Caught rather than left to throw. A misconfigured board — wrong host, a slug that is not
   * there, a feed that is down — is the likeliest state for anybody running this on a board
   * other than the one it was written against, and an uncaught rejection buries the reason in a
   * stack trace. It is a failing assertion with a sentence, like everything else here.
   */
  let reading: Reading | null = null;
  try {
    reading = await read();
    ok(`${cfg.url} answers`, true);
  } catch (err) {
    ok(`${cfg.url} answers`, false, err instanceof Error ? err.message : String(err));
  }

  const now = reading ? standing(reading.projects, cfg.slug) : null;
  if (reading) {
    ok(
      `${cfg.slug} is on the live board`,
      now !== null,
      `not among the ${reading.projects.length} projects read — check LEADERBOARD_SLUG`,
    );
  }

  if (now && reading) {
    console.log(
      `  read #${now.position} of ${now.of} on ${now.me.votes} votes${
        now.next ? `, ${now.next.toBeat} off ${now.next.name}` : ", top of the board"
      }`,
    );

    const page = await fetch(`${cfg.url}/`, { headers: { accept: "text/html" } }).catch(
      () => null,
    );
    ok("the page loads", page?.ok === true, page ? `answered ${page.status}` : "it did not answer");
    const html = page?.ok ? await page.text() : "";

    /*
     * The cross-check, and the best assertion in this file: the board states the gap itself, in
     * the words a person reads, so comparing it to ours puts two independent implementations of
     * the same arithmetic against each other. Ours could be wrong in the same direction as every
     * expectation written above; it cannot also be wrong in the same direction as somebody
     * else's page.
     *
     * **Both numbers come out of the same HTML, and that is not a detail.** The first version of
     * this compared our gap — computed from the JSON — against the phrase on the page, and it
     * failed by exactly one the first time it ran while people were actually voting: a vote
     * landed between the two fetches, so the page was a moment fresher than the feed. An
     * assertion that cries wolf whenever the thing it watches is busy is worse than none, and
     * loosening it to a tolerance would have thrown away the only ±1 this file exists to catch.
     * So the rows are parsed out of the same document that prints the answer, and the comparison
     * has no clock in it at all.
     *
     * It is pinned to the board the pattern was written against. Any other leaderboard prints
     * its own thing in its own language, and asserting on a phrase it never claimed to have
     * would fail for whoever configured it — so the comparison is skipped there, and said to be
     * skipped, rather than turning "we cannot check this" into "this is broken".
     */
    const CROSS_CHECKED_HOST = "platanus-2026.crafter.run";
    const host = new URL(cfg.url).hostname;

    if (host !== CROSS_CHECKED_HOST) {
      console.log(
        `  NOTE ${host} is not the board this cross-check was written for (${CROSS_CHECKED_HOST}), so its own arithmetic is not compared`,
      );
    } else {
      const entities = (text: string) =>
        text
          .replace(/&#x27;|&#39;|&apos;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"');

      /** Every row the page drew, read off the labels it wrote for screen readers. */
      const rows: Project[] = [
        ...html.matchAll(
          /<li id="project-([^"]+)"[\s\S]{0,400}?aria-label="([^"]*?), posici\u00f3n \d+(?: compartida)?, (\d+) votos/g,
        ),
      ].map((m) => ({
        slug: m[1] as string,
        name: entities(m[2] as string),
        votes: Number(m[3]),
      }));

      /*
       * A redesign that breaks the row pattern has to FAIL rather than pass quietly: an
       * assertion that silently stops asserting is worse than one that never existed.
       */
      ok(
        "the page's own rows can still be read",
        rows.length >= 2,
        `${rows.length} rows parsed — the markup changed, so fix the pattern or drop the claim`,
      );

      /*
       * Anchored on the element that carries the claim, not on the sentence inside it. The first
       * version matched the Spanish wording ("N votos para superar a X") and broke the day the
       * board reworded it to "para alcanzar el #2 / Superar a PLUMB" — the check failed loudly,
       * which was the point, but a pattern that survives a copy edit is strictly better. The
       * class name is the stable part: if `target-copy` itself goes, the claim really is gone.
       */
      const stated =
        /class="target-copy"[\s\S]{0,400}?<strong>(\d+)<\/strong>[\s\S]{0,400}?<b>([^<]+)<\/b>/.exec(
          html,
        );
      const mine = standing(rows, cfg.slug);

      if (rows.length >= 2 && mine) {
        /*
         * Two sources of the same figure, so a mismatch is either a mid-read change or us
         * reading the wrong field. The count is what is compared and not the votes: projects
         * are fixed for the length of a vote, while the votes move every few seconds.
         */
        check(
          "the feed and the page list the same projects",
          rows.length,
          reading.projects.length,
        );

        if (mine.next) {
          ok(
            "the page still prints its own gap",
            stated !== null,
            "the phrase is gone — this comparison is now blind, so fix the pattern or drop the claim",
          );
          if (stated) {
            check("our gap matches the page's own", Number(stated[1]), mine.next.toBeat);
            ok(
              "and so does who has to be passed",
              mine.next.name.startsWith(entities(stated[2] as string)),
              `page says ${stated[2]}, we say ${mine.next.name}`,
            );
          }
        } else {
          ok(
            "at the top, the page states no gap",
            stated === null,
            "the page thinks there is a place above us and we do not",
          );
        }
      }
    }
  }
}

/**
 * The claim, against a real database.
 *
 * Two ticks in the same minute — an overlapping timer, a restart, a second container — must not
 * both come back true, and that is not something an assertion about the code can establish: the
 * guard is the `update ... where last_minute is distinct from` and only Postgres can be asked
 * whether it held. The chat is a throwaway JID, never a real one: `save` upserts, so a check
 * written with a genuine group would take it over and then delete it on cleanup.
 */
const CHECK_CHAT = "leaderboard-check-only@g.us";

if (!process.env["DATABASE_URL"]) {
  console.log("\nthe claim: skipped — set DATABASE_URL to check it against Postgres");
} else {
  console.log("\nthe claim (against Postgres):");
  try {
    await save({ chat: CHECK_CHAT, chatName: "leaderboard-check", cron: "* * * * *" });
    const saved = await forChat(CHECK_CHAT);
    ok("the watch saved", saved !== null, "nothing came back");
    check("with no snapshot yet", saved?.last, null);

    const minute = new Date();
    ok("the first claim of a minute wins", await claim(CHECK_CHAT, minute));
    ok("the second claim of the same minute does not", !(await claim(CHECK_CHAT, minute)));
    const later = new Date(minute.getTime() + 60_000);
    ok("the next minute wins again", await claim(CHECK_CHAT, later));

    ok("a bad cron is refused rather than stored", await save({ chat: CHECK_CHAT, cron: "nope" }).then(() => false, () => true));

    /*
     * The note is what makes one group sound different from the next, so it has to survive the
     * round trip verbatim — and blank has to come back as absent rather than as an empty steer,
     * or the prompt is handed a line telling it to sound like nothing in particular.
     */
    await save({ chat: CHECK_CHAT, note: "  peruano, seco, con jerga  " });
    check("the note round-trips, trimmed", (await forChat(CHECK_CHAT))?.note, "peruano, seco, con jerga");
    await save({ chat: CHECK_CHAT, note: "   " });
    check("blank comes back as no steer at all", (await forChat(CHECK_CHAT))?.note, null);

    /*
     * The snapshot and the daily counter, which share one statement and are the two things a
     * watch gets wrong silently: a snapshot that does not land means every tick re-announces an
     * unchanged board, and a counter that resets on every send means the cap does nothing.
     */
    const day = new Date();
    await markAnnounced(CHECK_CHAT, woki, day);
    const first = await forChat(CHECK_CHAT, day);
    check("the snapshot is written down", first?.last, { position: 5, votes: 61, gap: 23 });
    check("and counts as one for today", first?.announcedToday, 1);

    await markAnnounced(CHECK_CHAT, woki, day);
    check("a second send adds to the day", (await forChat(CHECK_CHAT, day))?.announcedToday, 2);

    /*
     * Tomorrow the count is not two. It is not reset by a job either — the row still holds
     * yesterday's number, and `announcedToday` is what refuses to read it as today's.
     */
    const tomorrow = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    check("tomorrow starts from nothing", (await forChat(CHECK_CHAT, tomorrow))?.announcedToday, 0);
    await markAnnounced(CHECK_CHAT, woki, tomorrow);
    check(
      "and a send tomorrow is that day's first",
      (await forChat(CHECK_CHAT, tomorrow))?.announcedToday,
      1,
    );
    check(
      "while today's count is gone, not added to",
      (await forChat(CHECK_CHAT, day))?.announcedToday,
      0,
    );
  } finally {
    await remove(CHECK_CHAT);
    const gone = await forChat(CHECK_CHAT);
    ok("the throwaway watch is cleaned up", gone === null, "it is still there");
  }
}

console.log(
  failures === 0
    ? "\n  the gap arithmetic holds, ties included\n"
    : `\n  ${failures} failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
