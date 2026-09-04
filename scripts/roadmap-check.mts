/**
 * Supporter-weighted voting, against the real database.
 *
 * A tally is arithmetic that looks right and often is not. The specific failure this exists for is
 * **voting twice doubling a weight**: it costs nothing at write time, corrupts every tally after,
 * and nothing anywhere says so. The primary key on `(item_id, supporter_id)` is what prevents it —
 * on the *supporter*, not the identity, because one person holding both a LID and a username could
 * otherwise back the same thing once as each.
 *
 * Writes under names that cannot collide and deletes them. Needs DATABASE_URL; costs nothing.
 *
 *   npm run roadmap-check
 */

import { query } from "../lib/db.js";
import * as supporters from "../lib/supporters.js";
import * as roadmap from "../lib/roadmap.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const MARK = "roadmap-check";
const ANA = "51900000001";
const BETO = "51900000002";
const WHALE = "51900000003";
const STRANGER = "51900000009";

const cleanup = async () => {
  await query("delete from roadmap_items where title like $1", [`${MARK}%`]);
  await query("delete from supporters where name like $1", [`${MARK}%`]);
  // Votes cascade from the supporters and items above, so there is nothing else to clear.
};

await cleanup();

try {
  // ── the weight ─────────────────────────────────────────────────────────
  console.log("\nweight:");
  await supporters.add({ name: `${MARK} Ana`, handles: ANA, via: "yape", coffees: 1 });
  await supporters.add({ name: `${MARK} Beto`, handles: BETO, via: "coffee", coffees: 3 });
  await supporters.add({ name: `${MARK} Whale`, handles: WHALE, via: "coffee", coffees: 50 });
  supporters.forget();

  const ana = (await supporters.byHandle(ANA))!;
  const beto = (await supporters.byHandle(BETO))!;
  const whale = (await supporters.byHandle(WHALE))!;

  check("one coffee is worth one", supporters.weightFor(ana) === 1);
  check("three coffees are worth three", supporters.weightFor(beto) === 3);
  check(
    `fifty saturates at ${supporters.MAX_WEIGHT}`,
    supporters.weightFor(whale) === supporters.MAX_WEIGHT,
    `— ${supporters.weightFor(whale)}`,
  );
  check("a non-supporter is worth nothing", supporters.weightFor(null) === 0);
  check("the true count is still visible", whale.coffees === 50);

  // ── voting ─────────────────────────────────────────────────────────────
  console.log("\nvoting:");
  const a = await roadmap.add({ title: `${MARK} polls`, state: "open" });
  const b = await roadmap.add({ title: `${MARK} translations`, state: "open" });
  const c = await roadmap.add({ title: `${MARK} exports`, state: "open" });
  const d = await roadmap.add({ title: `${MARK} search`, state: "open" });
  const pending = await roadmap.add({ title: `${MARK} someone's idea`, state: "proposed" });

  check("a supporter's vote is accepted", (await roadmap.vote(ANA, a)).ok);
  check("a stranger's is not", !(await roadmap.vote(STRANGER, a)).ok);
  check(
    "and the refusal says why",
    ((await roadmap.vote(STRANGER, a)) as { why: string }).why.includes("supporters"),
  );
  check("a proposal cannot be voted on", !(await roadmap.vote(BETO, pending)).ok);
  check(
    "and says it is waiting",
    ((await roadmap.vote(BETO, pending)) as { why: string }).why.includes("approved"),
  );

  // ── the tally ──────────────────────────────────────────────────────────
  console.log("\nthe tally:");
  await roadmap.vote(BETO, a);
  await roadmap.vote(WHALE, a);

  const tallied = (await roadmap.byId(a))!;
  check(
    "it sums weights, not heads",
    tallied.weight === 1 + 3 + supporters.MAX_WEIGHT,
    `— ${tallied.weight} from ${tallied.backers} backers`,
  );
  check("and counts the backers separately", tallied.backers === 3);

  // The one that matters.
  const before = (await roadmap.byId(a))!.weight;
  await roadmap.vote(ANA, a);
  await roadmap.vote(ANA, a);
  const after = (await roadmap.byId(a))!.weight;
  check("voting again does not double anybody", after === before, `— ${before} then ${after}`);
  check("re-voting is not reported as a failure", (await roadmap.vote(ANA, a)).ok);

  // ── the cap ────────────────────────────────────────────────────────────
  console.log(`\nthe ${roadmap.MAX_OPEN_VOTES}-vote cap:`);
  await roadmap.vote(ANA, b);
  await roadmap.vote(ANA, c);
  check("three open votes are allowed", (await roadmap.openVotesOf(ana.id)).length === 3);

  const fourth = await roadmap.vote(ANA, d);
  check("a fourth is refused", !fourth.ok);
  check(
    "and names what they are holding",
    (fourth as { holding?: unknown[] }).holding?.length === 3,
  );

  check("dropping one frees a slot", await roadmap.unvote(ANA, c));
  check("the fourth then goes through", (await roadmap.vote(ANA, d)).ok);

  // ── finishing an item ──────────────────────────────────────────────────
  console.log("\nshipping:");
  check("still at the cap", (await roadmap.openVotesOf(ana.id)).length === 3);
  await roadmap.setState(a, "shipped");
  check(
    "a shipped item stops counting against the cap",
    (await roadmap.openVotesOf(ana.id)).length === 2,
    `— ${(await roadmap.openVotesOf(ana.id)).length}`,
  );
  const shipped = (await roadmap.byId(a))!;
  check("but its votes are kept as history", shipped.backers === 3, `— ${shipped.backers}`);
  check("and it is stamped", shipped.settledAt !== null);

  // ── a supporter who leaves ─────────────────────────────────────────────
  console.log("\nwhen a supporter is removed:");
  const whaleRow = (await supporters.list()).find((s) => s.name === `${MARK} Whale`)!;
  await supporters.remove(whaleRow.id);
  supporters.forget();
  const afterRemoval = (await roadmap.byId(a))!;
  check(
    "their weight leaves the tally with them",
    afterRemoval.weight === 1 + 3,
    `— ${afterRemoval.weight}`,
  );

  /*
   * One person, several identities.
   *
   * The bug this closes: Cristian is 188025162178706 to the bot in a group and _cris.fast to his
   * friends, and neither is derivable from the other — wapi maps phone to LID and back, and
   * nothing resolves a username at all. With a single handle column, whichever one you did not
   * type simply never matched, silently.
   */
  console.log("\nseveral identities, one person:");
  /*
   * Deliberately unreal. `tie` moves a handle on conflict — right for the dashboard, where the
   * common case is fixing a typo — which means a check written with a genuine identity would
   * steal it from the real supporter and then destroy it on cleanup. It did, once.
   */
  const LID = "900000000000001";
  const USERNAME = "_roadmap.check.only";
  await supporters.add({
    name: `${MARK} Cristian`,
    handles: [LID, USERNAME],
    via: "coffee",
    coffees: 2,
  });
  supporters.forget();

  const viaLid = await supporters.byHandle(LID);
  const viaName = await supporters.byHandle(USERNAME);
  check("found by the LID", viaLid?.name === `${MARK} Cristian`);
  check("found by the username", viaName?.name === `${MARK} Cristian`);
  check("and it is the same person", viaLid?.id === viaName?.id, `— ${viaLid?.id} vs ${viaName?.id}`);
  check(
    "however the identity was written",
    (await supporters.byHandle(`@${USERNAME.toUpperCase()}`))?.id === viaLid?.id,
  );
  check("both are listed against them", (viaLid?.handles.length ?? 0) === 2);

  // Both identities are one vote, which is the whole reason votes key on the supporter.
  const shared = await roadmap.add({ title: `${MARK} shared`, state: "open" });
  await roadmap.vote(LID, shared);
  await roadmap.vote(USERNAME, shared);
  const sharedItem = (await roadmap.byId(shared))!;
  check(
    "voting under both identities counts once",
    sharedItem.backers === 1 && sharedItem.weight === 2,
    `— ${sharedItem.weight} points from ${sharedItem.backers}`,
  );
  check(
    "and the cap sees one person, not two",
    (await roadmap.openVotesOf(viaLid!.id)).length === 1,
  );

  // The perk has to follow every identity too, or it works under one spelling and not the other.
  const marked = await supporters.handles();
  check("the rate-limit perk recognises the LID", marked.has(LID));
  check("and the username", marked.has(USERNAME));

  // Editing the set removes what is no longer there, and only for that person.
  await supporters.update(viaLid!.id, {
    name: `${MARK} Cristian`,
    handles: LID,
    note: null,
    coffees: 2,
  });
  supporters.forget();
  check("dropping an identity unties it", (await supporters.byHandle(USERNAME)) === null);
  check("while the other still resolves", (await supporters.byHandle(LID))?.id === viaLid!.id);
  check(
    "and nobody else lost theirs",
    (await supporters.byHandle(ANA))?.name === `${MARK} Ana`,
  );

  // ── what the bot reads out ─────────────────────────────────────────────
  console.log("\nwhat the bot says:");
  const { text, numbering } = roadmap.render(await roadmap.list());
  check("it numbers the open items from one", numbering.get(1) !== undefined);
  check(
    "the numbering maps to real items",
    [...numbering.values()].every((id) => typeof id === "number"),
  );
  check("it mentions points", /point/.test(text));
  check("it lists what shipped", /shipped/i.test(text));
  check("an empty roadmap reads as empty", roadmap.render([]).text.includes("Nothing"));
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
