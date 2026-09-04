/**
 * Chiming in, against a real database.
 *
 * The feature is almost entirely restraint, and every part of that restraint fails silently:
 * a bot that speaks too often is annoying rather than broken, and nothing throws. So each
 * condition is checked as a condition — with rows in the real tables, since the interesting ones
 * (the claim, the daily cap, the watermark) are SQL, not TypeScript.
 *
 * The two that would actually cost something:
 *
 * - **Claiming twice.** `last_chime_at` moves when a run *starts*. Left to move on success, a
 *   chat stays due while its turn is being written, and any run slower than the tick speaks
 *   twice. This is the reminder bug, one table over.
 * - **Quiet hours across midnight.** 23→8 contains neither endpoint in the usual order, and
 *   getting it backwards means the bot messages a group at four in the morning — which is the
 *   one failure here nobody would forgive.
 *
 * Writes under a chat id that cannot collide and deletes it. Needs DATABASE_URL; costs nothing,
 * and never calls the model.
 *
 *   npm run chime-check
 */

import { query } from "../lib/db.js";
import * as chime from "../lib/chime.js";
import { split } from "../lib/chime-runner.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const CHAT = "000000000000000000@g.us-chime-check";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

const cleanup = async () => {
  await query("delete from chime_settings where chat = $1", [CHAT]);
  await query("delete from chimes where chat = $1", [CHAT]);
  await query("delete from logged_messages where chat = $1", [CHAT]);
};

/** Messages in the recorded log, as if people had been talking. */
const say = async (n: number, agoMinutes: number) => {
  for (let i = 0; i < n; i++) {
    await query(
      `insert into logged_messages (chat, message_id, sender_name, kind, text, at, urls)
       values ($1, $2, $3, 'text', $4, $5, '{}')`,
      [CHAT, `chime-check-${Date.now()}-${i}-${Math.random()}`, "Ana", `line ${i}`, minutesAgo(agoMinutes)],
    );
  }
};

const settings = async (): Promise<chime.Settings> => {
  const s = await chime.forChat(CHAT);
  if (!s) throw new Error("the row went missing");
  return s;
};

await cleanup();

try {
  // ── quiet hours ────────────────────────────────────────────────────────
  console.log("\nquiet hours:");
  const at = (hourLocal: number): Date => {
    /*
     * Built by searching rather than by arithmetic: the bot's timezone is a config value and may
     * have an offset with minutes in it, so "add N hours to midnight UTC" is not the same hour
     * everywhere. This asks the same formatter the code asks.
     */
    for (let h = 0; h < 48; h++) {
      const candidate = new Date(Date.UTC(2026, 0, 15, h, 30));
      if (chime.localHour(candidate) === hourLocal) return candidate;
    }
    throw new Error(`no ${hourLocal}:00 found`);
  };

  const overnight = { quietFrom: 23, quietTo: 8 } as chime.Settings;
  check("04:00 is quiet when quiet is 23→8", chime.isQuiet(overnight, at(4)));
  check("23:00 is quiet", chime.isQuiet(overnight, at(23)));
  check("08:00 is not", !chime.isQuiet(overnight, at(8)));
  check("15:00 is not", !chime.isQuiet(overnight, at(15)));

  const daytime = { quietFrom: 9, quietTo: 17 } as chime.Settings;
  check("a daytime range works the ordinary way", chime.isQuiet(daytime, at(12)));
  check("and leaves the evening alone", !chime.isQuiet(daytime, at(20)));

  const never = { quietFrom: 0, quietTo: 0 } as chime.Settings;
  check("equal endpoints mean never quiet", !chime.isQuiet(never, at(3)));

  // ── the conditions ─────────────────────────────────────────────────────
  console.log("\nwhen it holds its tongue:");
  await chime.save({ chat: CHAT, chatName: "chime-check", everyMinutes: 60, minMessages: 5, quietFrom: 0, quietTo: 0, maxPerDay: 2 });

  const now = new Date();
  check("a brand new group with nothing said holds", (await chime.holdReason(await settings(), now))?.includes("new message") === true,
    `— ${await chime.holdReason(await settings(), now)}`);

  await say(3, 5);
  check(
    "three messages when five are needed still holds",
    (await chime.holdReason(await settings(), now))?.includes("needs 5") === true,
  );

  await say(2, 5);
  check("five is enough", (await chime.holdReason(await settings(), now)) === null);

  // ── freshness ──────────────────────────────────────────────────────────
  console.log("\nwhen the conversation is over:");
  await query("delete from logged_messages where chat = $1", [CHAT]);
  await say(6, chime.FRESH_MINUTES + 30);
  check(
    "plenty said, but hours ago, and it stays out of it",
    (await chime.holdReason(await settings(), now))?.includes("gone quiet") === true,
    `— ${await chime.holdReason(await settings(), now)}`,
  );

  await say(1, 1);
  check("one recent message brings it back", (await chime.holdReason(await settings(), now)) === null);

  // ── the claim ──────────────────────────────────────────────────────────
  console.log("\nthe claim:");
  check("the first claim is taken", await chime.claim(CHAT, now));
  check("a second, immediately, is refused", !(await chime.claim(CHAT, now)));
  check(
    "and it says so on the page",
    (await chime.holdReason(await settings(), now))?.includes("spoke recently") === true,
    `— ${await chime.holdReason(await settings(), now)}`,
  );
  check(
    "an hour later it is due again",
    await chime.claim(CHAT, new Date(now.getTime() + 61 * 60 * 1000)),
  );

  // ── the daily cap ──────────────────────────────────────────────────────
  console.log("\nthe daily cap:");
  /*
   * The cadence is cleared first, on purpose. `holdReason` reports the *first* reason it finds,
   * cheapest first, so a chat still inside its cadence would answer "spoke recently" and the cap
   * below would never be reached — a check that passes while testing nothing.
   */
  await query("update chime_settings set last_chime_at = null where chat = $1", [CHAT]);
  await chime.record(CHAT, "something", now);
  check("one so far today", (await chime.spokenToday(CHAT, now)) === 1);
  await chime.record(CHAT, "something else", now);
  check(
    "at the cap, it holds regardless of how lively it is",
    (await chime.holdReason(await settings(), now))?.includes("limit of 2") === true,
    `— ${await chime.holdReason(await settings(), now)}`,
  );
  check(
    "yesterday's count does not spend today's allowance",
    (await chime.spokenToday(CHAT, new Date(now.getTime() + 36 * 3600 * 1000))) === 0,
  );

  // ── the watermark ──────────────────────────────────────────────────────
  console.log("\nthe watermark:");
  const before = (await settings()).chimedTo;
  await chime.markChimed(CHAT, now);
  const after = (await settings()).chimedTo;
  check("it moves", before === null && after !== null);
  const windowAfter = await chime.windowFor(await settings(), new Date(now.getTime() + 1000));
  check("and what came before it is not read again", windowAfter.messages.length === 0);

  // ── bounds ─────────────────────────────────────────────────────────────
  console.log("\nbounds:");
  await chime.save({ chat: CHAT, everyMinutes: 1, minMessages: 0, maxPerDay: 500 });
  const clamped = await settings();
  check("a one-minute cadence is refused", clamped.everyMinutes >= 15, `— ${clamped.everyMinutes}`);
  check("so is a daily cap of 500", clamped.maxPerDay <= 12, `— ${clamped.maxPerDay}`);
  check("and a threshold of zero", clamped.minMessages >= 2, `— ${clamped.minMessages}`);

  // ── what gets sent ─────────────────────────────────────────────────────
  console.log("\nturning an answer into messages:");
  check("nothing stays nothing", split("").length === 0);
  check("whitespace is nothing too", split("  \n \n ").length === 0);
  check("one paragraph is one message", split("just this").length === 1);
  check(
    "a blank line separates two",
    split("first thing\n\nsecond thing").length === 2,
  );
  check(
    "a single newline does not",
    split("a line\nand its continuation").length === 1,
  );
  check("and it never turns into a monologue", split("a\n\nb\n\nc\n\nd\n\ne").length === 3);
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
