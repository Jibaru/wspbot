/**
 * Supporters, and the identity matching that makes them useful.
 *
 * The interesting part is `normalise`. A phone number reaches this app as a JID with a device
 * suffix and is reduced to bare digits before anything compares it; a supporter typed in by hand
 * arrives as whatever somebody pasted. If those two do not land on the same string, the star
 * never appears and nothing anywhere says why — the row is there, the person is there, and they
 * simply never meet.
 *
 * The Buy Me a Coffee section runs only when BUYMEACOFFEE_TOKEN is set. Their response shape is
 * the one thing here that has not been verified against a live account, so this is where that
 * gets settled the moment a token exists.
 *
 * Writes under a handle that cannot collide and deletes it. Needs DATABASE_URL.
 *
 *   npm run supporters-check
 */

import { query } from "../lib/db.js";
import * as supporters from "../lib/supporters.js";
import * as people from "../lib/people.js";
import * as mentions from "../lib/mentions.js";
import { config } from "../lib/config.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const MARK = "supporters-check";
const cleanup = () => query("delete from supporters where name like $1", [`${MARK}%`]);

await cleanup();

try {
  // ── normalising ────────────────────────────────────────────────────────
  console.log("\nidentities:");
  for (const [input, want] of [
    ["51999888777", "51999888777"],
    ["+51 999 888 777", "51999888777"],
    ["51999888777@s.whatsapp.net", "51999888777"],
    ["51999888777:12@s.whatsapp.net", "51999888777"],
    ["99887766@lid", "99887766"],
    ["@ana.perez", "ana.perez"],
    ["Ana.Perez", "ana.perez"],
    ["@ANA", "ana"],
    ["", ""],
  ] as const) {
    check(`"${input}" → "${want}"`, supporters.normalise(input) === want,
      `— got "${supporters.normalise(input)}"`);
  }

  /**
   * The one that matters: what the webhook computes for a sender, and what a hand-typed
   * supporter becomes, have to be the same string.
   */
  const sender = "51999888777:12@s.whatsapp.net";
  check(
    "a hand-typed number matches what the webhook derives from a sender",
    supporters.normalise("+51 999 888 777") === mentions.identityKey(sender),
    `— "${supporters.normalise("+51 999 888 777")}" vs "${mentions.identityKey(sender)}"`,
  );

  // ── the round trip ─────────────────────────────────────────────────────
  console.log("\nstoring:");
  await supporters.add({
    name: `${MARK} Ana`,
    handle: "+51 999 888 777",
    via: "yape",
    note: "bought the credits",
  });
  await supporters.add({ name: `${MARK} Beto`, via: "coffee", externalId: "coffee-1" });

  const all = (await supporters.list()).filter((s) => s.name.startsWith(MARK));
  check("both were stored", all.length === 2, `— ${all.length}`);
  const ana = all.find((s) => s.name.endsWith("Ana"))!;
  check("the handle was normalised on the way in", ana.handle === "51999888777", `— ${ana.handle}`);
  check("a supporter with no handle is allowed", all.find((s) => s.name.endsWith("Beto"))?.handle === null);

  supporters.forget();
  const marked = await supporters.handles();
  check("the handle set contains them", marked.has("51999888777"));
  check("and nothing else", !marked.has("51999888778"));

  // A second pull of the same coffee id must not duplicate the person.
  await supporters.add({ name: `${MARK} Beto again`, via: "coffee", externalId: "coffee-1" });
  const afterDupe = (await supporters.list()).filter((s) => s.name.startsWith(MARK));
  check("the same external id does not add a second row", afterDupe.length === 2, `— ${afterDupe.length}`);

  // ── editing ────────────────────────────────────────────────────────────
  console.log("\nediting:");
  await supporters.update(ana.id, { name: `${MARK} Ana Perez`, handle: "@ana", note: null });
  const edited = (await supporters.list()).find((s) => s.id === ana.id)!;
  check("the name changed", edited.name === `${MARK} Ana Perez`);
  check("a username handle normalises too", edited.handle === "ana", `— ${edited.handle}`);
  check("the note was cleared", edited.note === null);

  // ── the directory ──────────────────────────────────────────────────────
  console.log("\nthe picker's list:");
  supporters.forget();
  const directory = await people.directory();
  const entry = directory.find((p) => p.handle === "ana");
  check("the supporter is in the directory", Boolean(entry));
  check("carrying their name rather than the handle", entry?.label === `${MARK} Ana Perez`);
  check("and marked as a supporter", entry?.supporter === true);
  check("with where it came from", entry?.seen.includes("supporter") === true);
  check(
    "supporters sort first",
    directory.length === 0 || directory[0]?.supporter === true,
  );
  check(
    "handles are unique — one person is one entry",
    new Set(directory.map((p) => p.handle)).size === directory.length,
  );

  // ── what the bot reads out ─────────────────────────────────────────────
  console.log("\nwhat the bot says:");
  const rendered = supporters.render(
    (await supporters.list()).filter((s) => s.name.startsWith(MARK)),
  );
  check("it names them", rendered.includes("Ana Perez") && rendered.includes("Beto"));
  check("it says how they helped", rendered.includes("Yape") && rendered.includes("Buy Me a Coffee"));
  check("it carries no amounts", !/\d+[.,]\d{2}|\$|S\/|PEN|USD/.test(rendered), `— ${rendered.replace(/\n/g, " | ")}`);
  check("an empty list reads as empty", supporters.render([]) === "(nobody yet)");

  // ── Buy Me a Coffee ────────────────────────────────────────────────────
  console.log("\nbuy me a coffee:");
  if (!config.coffeeToken()) {
    console.log("  SKIP no BUYMEACOFFEE_TOKEN set — the API shape is unverified until there is one");
  } else {
    const found = await supporters.fetchCoffee();
    check("the API answered with a list", Array.isArray(found), `— ${found.length} supporter(s)`);
    check(
      "every row has an id and a name",
      found.every((f) => f.externalId && f.name),
    );
    check(
      "any date parsed",
      found.every((f) => f.at === null || !Number.isNaN(f.at.getTime())),
    );
  }
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
