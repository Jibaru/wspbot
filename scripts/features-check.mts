/**
 * Does every tool the agent defines belong to a feature?
 *
 * The switches on the dashboard work by withdrawing a feature's tools, so a tool that no
 * feature owns is one the switches cannot reach: it stays available with everything turned off,
 * and nothing in a typecheck or a build notices. The same goes the other way — a feature naming
 * a tool that has since been renamed silently stops withdrawing anything.
 *
 * So this reads the actual source of `lib/agent.ts` rather than trusting a list, and compares
 * both directions. Needs no keys and no database.
 *
 *   npm run features-check
 */

import { readFileSync } from "node:fs";
import { FEATURES } from "../lib/features";

/**
 * Tools that are deliberately outside the switches. Empty today, and a tool belongs here only
 * with a reason written next to it — the default has to be that a new ability is switchable.
 */
const UNSWITCHABLE = new Set<string>([]);

const source = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");

/**
 * Tool definitions look like `name: tool({` or, for the one the provider executes,
 * `web_search: openai.tools.webSearch(`. Matching the source is the point: a list maintained by
 * hand would drift in exactly the way this exists to catch.
 */
const defined = new Set(
  [...source.matchAll(/^\s+([a-z_][a-z0-9_]*): (?:tool\(|openai\.tools\.)/gm)].map(
    (m) => m[1] as string,
  ),
);

const owned = new Map<string, string>();
for (const feature of FEATURES) {
  for (const name of feature.tools) {
    const already = owned.get(name);
    if (already) {
      console.error(`  FAIL ${name} is claimed by both ${already} and ${feature.key}`);
      process.exit(1);
    }
    owned.set(name, feature.key);
  }
}

const unowned = [...defined].filter((t) => !owned.has(t) && !UNSWITCHABLE.has(t));
const missing = [...owned.keys()].filter((t) => !defined.has(t));

console.log(`  ${defined.size} tools defined in lib/agent.ts`);
console.log(`  ${owned.size} claimed by ${FEATURES.length} features`);

let bad = false;

if (defined.size === 0) {
  console.error("  FAIL no tools matched — the pattern has drifted from the source");
  bad = true;
}

if (unowned.length) {
  console.error(
    `  FAIL no feature owns: ${unowned.join(", ")} — these cannot be switched off`,
  );
  bad = true;
}

if (missing.length) {
  console.error(
    `  FAIL claimed but not defined: ${missing.join(", ")} — renamed or removed?`,
  );
  bad = true;
}

/**
 * A feature that owns tools is switched off by having them withdrawn, and needs nothing else.
 * A feature that owns *no* tools has to be read somewhere by hand — in the prompt, the webhook
 * handler, the reminder tick — or its switch is decoration: it stores a row, changes the page,
 * and changes nothing the bot does.
 */
const GATES = ["lib/agent.ts", "lib/about.ts", "app/api/wapi/webhook/route.ts", "lib/reminder-runner.ts"]
  .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))
  .join("\n");

const inert = FEATURES.filter(
  (f) => f.tools.length === 0 && !GATES.includes(`has("${f.key}")`),
).map((f) => f.key);

if (inert.length) {
  console.error(
    `  FAIL ${inert.join(", ")} own no tools and are read nowhere — the switch would do nothing`,
  );
  bad = true;
}

/**
 * The README opens with a table of figures — how many features, tools, tables, checks. Numbers
 * in prose rot faster than anything else, and silently: "seven sections" survived the arrival of
 * an eighth without a murmur. So they are computed here and looked for verbatim.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");

const claims: [string, string][] = [
  [
    "feature and tool counts",
    `${FEATURES.length} switchable features over ${defined.size} model tools`,
  ],
  ["table count", `Postgres, ${(db.match(/create table if not exists/g) ?? []).length} tables`],
  [
    "check-script count",
    `${Object.keys(pkg.scripts).filter((s) => s.endsWith("check") || s === "smoke").length} check scripts`,
  ],
];

for (const [what, phrase] of claims) {
  if (readme.includes(phrase)) continue;
  console.error(`  FAIL README's ${what} is stale — it should read "${phrase}"`);
  bad = true;
}

if (bad) process.exit(1);
console.log("  every tool belongs to a feature, and every claimed tool exists");
console.log("  every tool-less feature is read by hand somewhere");
console.log("  the README's figures match the code");
