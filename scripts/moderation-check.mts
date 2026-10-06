/**
 * Removing people from a group — the refusals, which are the whole feature.
 *
 * This is the only irreversible thing the bot does, and every way it goes wrong is silent: a
 * permission that defaults open, a protection that stops protecting, a ceiling that counts the
 * wrong rows. None of them throws. So `decide` is a pure function and every branch of it is
 * asserted here, with the dangerous ones stated as what they would cost:
 *
 * - **An admin must never be removable.** Not by request, not by judgement, not with every
 *   switch on. It is the first thing checked and the first thing checked here.
 * - **A stranger must not be able to ask.** Only an admin of the group, and only by replying to
 *   the message of the person they mean — the tool takes no target at all, which is what stops
 *   "@bot throw Ana out" from being a sentence that works.
 * - **Acting unasked is opt-in.** A deployment that never ticks that box has a bot that can only
 *   ever be an admin's instrument.
 *
 * Writes under a chat id that cannot collide and deletes it. Needs DATABASE_URL, costs nothing,
 * and removes nobody from anything.
 *
 *   npm run moderation-check
 */

import { query } from "../lib/db.js";
import * as moderation from "../lib/moderation.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const CHAT = "000000000000000000@g.us-moderation-check";
const RUDE = "51900000000001";
const ADMIN = "51900000000002";

const cleanup = async () => {
  await query("delete from moderation_settings where chat = $1", [CHAT]);
  await query("delete from moderation_log where chat = $1", [CHAT]);
  moderation.forget();
};

/** Everything allowed, nothing protected: the most permissive request there can be. */
const base: moderation.Request = {
  settings: {
    chat: CHAT,
    chatName: "check",
    enabled: true,
    onRequest: true,
    onOwnJudgement: true,
    warnFirst: false,
    warnWindowHours: 24,
    maxPerDay: 2,
    note: null,
  },
  target: RUDE,
  asked: false,
  askerIsAdmin: false,
  targetIsAdmin: false,
  targetIsOwner: false,
  targetIsSelf: false,
  removedToday: 0,
  alreadyWarned: false,
};

const why = (d: moderation.Decision) => (d.action === "refuse" ? d.why : d.action);

await cleanup();

try {
  // ── what is never allowed ──────────────────────────────────────────────
  console.log("\nwhat no setting can turn on:");
  check("an admin is never removable", moderation.decide({ ...base, targetIsAdmin: true }).action === "refuse",
    `— ${why(moderation.decide({ ...base, targetIsAdmin: true }))}`);
  check(
    "not even when an admin asks for it",
    moderation.decide({ ...base, targetIsAdmin: true, asked: true, askerIsAdmin: true }).action === "refuse",
  );
  check("the owner is never removable", moderation.decide({ ...base, targetIsOwner: true }).action === "refuse");
  check("and it will not remove itself", moderation.decide({ ...base, targetIsSelf: true }).action === "refuse");

  /*
   * The protections are checked before any permission, so no combination reaches past them. A
   * reordering that put the switches first would be invisible until the day it mattered.
   */
  const everythingOn = { ...base, asked: true, askerIsAdmin: true, targetIsAdmin: true };
  check(
    "protection wins over every permission at once",
    moderation.decide(everythingOn).action === "refuse" &&
      why(moderation.decide(everythingOn)).includes("admin"),
  );

  // ── who may ask ────────────────────────────────────────────────────────
  console.log("\nwho may ask:");
  check(
    "a member asking is refused",
    moderation.decide({ ...base, asked: true, askerIsAdmin: false }).action === "refuse",
    `— ${why(moderation.decide({ ...base, asked: true, askerIsAdmin: false }))}`,
  );
  check(
    "an admin asking is allowed",
    moderation.decide({ ...base, asked: true, askerIsAdmin: true }).action === "remove",
  );
  check(
    "with requests switched off, even an admin is refused",
    moderation.decide({
      ...base,
      settings: { ...base.settings!, onRequest: false },
      asked: true,
      askerIsAdmin: true,
    }).action === "refuse",
  );

  // ── acting unasked ─────────────────────────────────────────────────────
  console.log("\nacting with nobody asking:");
  check(
    "allowed only where it was switched on",
    moderation.decide(base).action === "remove",
  );
  check(
    "and refused where it was not",
    moderation.decide({ ...base, settings: { ...base.settings!, onOwnJudgement: false } }).action ===
      "refuse",
  );
  check(
    "which is the default for a new group",
    moderation.DEFAULTS.onOwnJudgement === false,
  );
  check(
    "a group that was never set up cannot be acted in",
    moderation.decide({ ...base, settings: null }).action === "refuse",
  );
  check(
    "nor one that is switched off",
    moderation.decide({ ...base, settings: { ...base.settings!, enabled: false } }).action === "refuse",
  );

  // ── the warning ────────────────────────────────────────────────────────
  console.log("\nthe warning:");
  const warns = { ...base, settings: { ...base.settings!, warnFirst: true } };
  check("a first offence is a warning, not a removal", moderation.decide(warns).action === "warn");
  check(
    "a second one, inside the window, is a removal",
    moderation.decide({ ...warns, alreadyWarned: true }).action === "remove",
  );
  check(
    "an admin asking outright skips the warning",
    moderation.decide({ ...warns, asked: true, askerIsAdmin: true }).action === "remove",
  );

  // ── the ceiling ────────────────────────────────────────────────────────
  console.log("\nthe daily ceiling:");
  check("under it, allowed", moderation.decide({ ...base, removedToday: 1 }).action === "remove");
  check("at it, refused", moderation.decide({ ...base, removedToday: 2 }).action === "refuse");
  check(
    "and an admin cannot talk past it",
    moderation.decide({ ...base, removedToday: 2, asked: true, askerIsAdmin: true }).action ===
      "refuse",
  );

  // ── against the real tables ────────────────────────────────────────────
  console.log("\nagainst the database:");
  await moderation.save({ chat: CHAT, chatName: "moderation-check" });
  const saved = await moderation.forChat(CHAT);
  check("a new group defaults to request-only", saved?.onRequest === true && saved?.onOwnJudgement === false);
  check("and to warning first", saved?.warnFirst === true);

  await moderation.record({
    chat: CHAT,
    target: RUDE,
    targetName: "Rude",
    askedBy: null,
    outcome: "warned",
    reason: "check",
  });
  check("a warning is found inside the window", await moderation.warnedRecently(CHAT, RUDE, 24));
  check(
    "and not outside it",
    !(await moderation.warnedRecently(CHAT, RUDE, 0)),
  );
  check(
    "somebody else's warning is not theirs",
    !(await moderation.warnedRecently(CHAT, ADMIN, 24)),
  );

  check("a warning does not count against the ceiling", (await moderation.removedToday(CHAT)) === 0);
  await moderation.record({
    chat: CHAT,
    target: RUDE,
    targetName: "Rude",
    askedBy: null,
    outcome: "removed",
    reason: "check",
  });
  check("a removal does", (await moderation.removedToday(CHAT)) === 1);
  await moderation.record({
    chat: CHAT,
    target: RUDE,
    targetName: "Rude",
    askedBy: null,
    outcome: "refused",
    reason: "check",
  });
  check("a refusal does not", (await moderation.removedToday(CHAT)) === 1);
  check(
    "but every one of them is in the record",
    (await moderation.history(CHAT, 10)).length === 3,
    "— a log that only shows removals cannot be audited",
  );

  // ── the gate on the chat ───────────────────────────────────────────────
  console.log("\nwhich groups at all:");
  check("a configured group is listed", (await moderation.moderatedChats()).has(CHAT));
  await moderation.setEnabled(CHAT, false);
  moderation.forget();
  check("switching it off takes it off the list", !(await moderation.moderatedChats()).has(CHAT));

  // ── bounds ─────────────────────────────────────────────────────────────
  console.log("\nbounds:");
  await moderation.save({ chat: CHAT, maxPerDay: 99, warnWindowHours: 0 });
  const clamped = await moderation.forChat(CHAT);
  check("a ceiling of 99 is clamped", (clamped?.maxPerDay ?? 0) <= 5, `— ${clamped?.maxPerDay}`);
  check("and a zero-hour warning window", (clamped?.warnWindowHours ?? 0) >= 1);
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
