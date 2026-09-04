/**
 * Supporter-weighted voting, against the real database.
 *
 * A tally is arithmetic that looks right and often is not. The specific failure this exists for is
 * **voting twice doubling a weight**: it costs nothing at write time, corrupts every tally after,
 * and nothing anywhere says so. The primary key on `(item_id, handle)` is what prevents it, and a
 * schema constraint is exactly the kind of thing that survives a refactor only if something checks.
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
  await query("delete from roadmap_votes where handle = any($1)", [[ANA, BETO, WHALE, STRANGER]]);
};

await cleanup();

try {
  // ── the weight ─────────────────────────────────────────────────────────
  console.log("\nweight:");
  await supporters.add({ name: `${MARK} Ana`, handle: ANA, via: "yape", coffees: 1 });
  await supporters.add({ name: `${MARK} Beto`, handle: BETO, via: "coffee", coffees: 3 });
  await supporters.add({ name: `${MARK} Whale`, handle: WHALE, via: "coffee", coffees: 50 });
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
  check("three open votes are allowed", (await roadmap.openVotesOf(ANA)).length === 3);

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
  check("still at the cap", (await roadmap.openVotesOf(ANA)).length === 3);
  await roadmap.setState(a, "shipped");
  check(
    "a shipped item stops counting against the cap",
    (await roadmap.openVotesOf(ANA)).length === 2,
    `— ${(await roadmap.openVotesOf(ANA)).length}`,
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
