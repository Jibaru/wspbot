/**
 * Supporters, and the identity matching that makes them useful.
 *
 * The interesting part is `normalise`. A phone number reaches this app as a JID with a device
 * suffix and is reduced to bare digits before anything compares it; a supporter typed in by hand
 * arrives as whatever somebody pasted. If those two do not land on the same string, the star
 * never appears and nothing anywhere says why — the row is there, the person is there, and they
 * simply never meet.
 *
 * It also drives the webhook signature — HMAC-SHA256 over the raw body, their scheme — through
 * every way it should fail, including a truncated one, since `timingSafeEqual` throws on a length
 * mismatch and a check that crashes is not a check that refuses.
 *
 * The Buy Me a Coffee section runs only when BUYMEACOFFEE_TOKEN is set, and then it talks to the
 * real API.
 *
 * Writes under a handle that cannot collide and deletes it. Needs DATABASE_URL.
 *
 *   npm run supporters-check
 */

import { createHmac } from "node:crypto";
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
  await supporters.update(ana.id, { name: `${MARK} Ana Perez`, handle: "@ana", note: null, coffees: 3 });
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

  // ── the webhook signature ──────────────────────────────────────────────
  console.log("\nwebhook signatures:");
  const body = JSON.stringify({ type: "donation.created", live_mode: true, data: { id: 1 } });
  const secret = "a-signing-secret";
  const good = createHmac("sha256", secret).update(body).digest("hex");

  check("a correct signature passes", supporters.verifySignature(body, good, secret));
  check("a missing one does not", !supporters.verifySignature(body, null, secret));
  check("an empty one does not", !supporters.verifySignature(body, "", secret));
  check(
    "a signature over a different body does not",
    !supporters.verifySignature(
      body,
      createHmac("sha256", secret).update(body + " ").digest("hex"),
      secret,
    ),
  );
  check(
    "the same body under a different secret does not",
    !supporters.verifySignature(
      body,
      createHmac("sha256", "other").update(body).digest("hex"),
      secret,
    ),
  );

  /** `timingSafeEqual` throws on a length mismatch, so a truncated one must fail, not crash. */
  let threw = false;
  let truncatedFailed = false;
  try {
    truncatedFailed = !supporters.verifySignature(body, good.slice(0, 20), secret);
  } catch {
    threw = true;
  }
  check("a truncated signature is refused", truncatedFailed);
  check("and refusing it did not throw", !threw);
  check(
    "surrounding whitespace is tolerated",
    supporters.verifySignature(body, "  " + good + "  ", secret),
  );

  // ── the webhook payload ────────────────────────────────────────────────
  console.log("\nwebhook payloads:");
  const donation = supporters.fromWebhook("donation.created", {
    id: 9911,
    supporter_name: "Someone",
    payer_name: "Someone Else",
    supporter_id: 42,
  });
  check("a donation yields a supporter", donation?.name === "Someone");
  check(
    "the id is namespaced by event type",
    donation?.externalId === "donation.created:9911",
    "— " + String(donation?.externalId),
  );
  check(
    "an anonymous donation falls back to the payer name",
    supporters.fromWebhook("donation.created", { id: 1, payer_name: "Card Holder" })?.name ===
      "Card Holder",
  );
  check(
    "with neither, it is Anonymous",
    supporters.fromWebhook("donation.created", { id: 1 })?.name === "Anonymous",
  );
  check(
    "nothing identifiable yields nothing",
    supporters.fromWebhook("donation.created", {}) === null,
  );

  // ── Buy Me a Coffee, live ──────────────────────────────────────────────
  console.log("\nbuy me a coffee:");
  if (!config.coffeeToken()) {
    console.log("  SKIP no BUYMEACOFFEE_TOKEN set");
  } else {
    const found = await supporters.fetchCoffee();
    check("the API answered", Array.isArray(found), "— " + found.length + " supporter(s)");
    check("every row has an id and a name", found.every((f) => f.externalId && f.name));
    check(
      "every date parsed",
      found.every((f) => f.at === null || !Number.isNaN(f.at.getTime())),
    );
    check("ids are unique", new Set(found.map((f) => f.externalId)).size === found.length);
    for (const f of found.slice(0, 5)) {
      console.log(
        "      " +
          f.externalId.padEnd(10) +
          " " +
          f.name +
          "  " +
          (f.at ? f.at.toISOString().slice(0, 10) : "no date"),
      );
    }
  }
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
