/**
 * Moving context between groups, against the real database.
 *
 * This one is worth exercising for real because the failure mode is losing somebody's notes: a
 * move is an update, and an update whose `where` clause is a shade wrong either takes the wrong
 * rows or silently takes none while reporting success. Nothing in a typecheck has an opinion
 * about either.
 *
 * Uses chat ids that cannot exist and deletes everything it writes. Needs DATABASE_URL; costs
 * nothing and sends nothing.
 *
 *   npm run transfer-check
 */

import { query } from "../lib/db.js";
import { GLOBAL } from "../lib/memory.js";
import * as transfer from "../lib/transfer.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const A = "transfer-check-a@invalid";
const B = "transfer-check-b@invalid";
const C = "transfer-check-c@invalid";
const PERSON = "51900000000@invalid";

const cleanup = async () => {
  for (const table of ["memories", "tasks", "reminders", "notion_connections"]) {
    await query(`delete from ${table} where chat = any($1)`, [[A, B, C]]);
  }
  await query("delete from memories where chat = $1 and text like $2", [GLOBAL, "transfer-check%"]);
};

await cleanup();

try {
  // ── seed ───────────────────────────────────────────────────────────────
  await query("insert into memories (chat, text, author) values ($1, $2, $3), ($1, $4, $3)", [
    A,
    "transfer-check the deploy is on Fridays",
    "Ana",
    "transfer-check the staging password rotates monthly",
  ]);
  await query("insert into memories (chat, text) values ($1, $2)", [
    GLOBAL,
    "transfer-check a global fact",
  ]);
  await query("insert into tasks (chat, text, added_by) values ($1, $2, $3), ($1, $4, $3)", [
    A,
    "transfer-check renew the certificate",
    "Beto",
    "transfer-check archive the old repo",
  ]);
  await query(
    "insert into reminders (chat, user_id, prompt, asked_by, next_at) values ($1, $2, $3, $4, now() + interval '1 day')",
    [A, PERSON, "transfer-check send the invoice", "Ana"],
  );
  await query(
    "insert into notion_connections (chat, access_token, workspace_name) values ($1, $2, $3)",
    [A, "transfer-check-token", "Acme"],
  );

  // ── the inventory ──────────────────────────────────────────────────────
  console.log("\nwhat can move:");
  const items = await transfer.inventory(A);
  const kinds = items.map((i) => i.kind);
  check("finds both facts", kinds.filter((k) => k === "memory").length === 2);
  check("finds both checklist items", kinds.filter((k) => k === "task").length === 2);
  check("finds the reminder", kinds.filter((k) => k === "reminder").length === 1);
  check("finds the Notion connection", kinds.filter((k) => k === "notion").length === 1);
  check(
    "leaves global facts out — they belong to no group",
    !items.some((i) => i.label.includes("a global fact")),
  );
  check("the destination starts empty", (await transfer.inventory(B)).length === 0);

  // ── moving ─────────────────────────────────────────────────────────────
  console.log("\nmoving:");
  const oneFact = items.find((i) => i.kind === "memory" && i.label.includes("Fridays"))!;
  const oneTask = items.find((i) => i.kind === "task")!;

  const moved = await transfer.transfer(A, B, [oneFact.ref, oneTask.ref], "move");
  check("both were reported done", moved.every((o) => o.done), `— ${moved.map((o) => o.done).join(", ")}`);

  const afterA = await transfer.inventory(A);
  const afterB = await transfer.inventory(B);
  check("they left the source", afterA.length === items.length - 2, `— ${afterA.length} left`);
  check("they arrived in the destination", afterB.length === 2, `— ${afterB.length} there`);
  check(
    "the right fact moved, not the other one",
    afterB.some((i) => i.label.includes("Fridays")) &&
      afterA.some((i) => i.label.includes("staging password")),
  );

  // ── copying ────────────────────────────────────────────────────────────
  console.log("\ncopying:");
  const remaining = (await transfer.inventory(A)).find((i) => i.kind === "memory")!;
  const copied = await transfer.transfer(A, B, [remaining.ref], "copy");
  check("the copy was reported done", copied[0]?.done === true);
  check(
    "the source still has it",
    (await transfer.inventory(A)).some((i) => i.label === remaining.label),
  );
  check(
    "and so does the destination",
    (await transfer.inventory(B)).some((i) => i.label === remaining.label),
  );

  // ── collisions ─────────────────────────────────────────────────────────
  console.log("\nwhat it refuses:");
  await query(
    "insert into reminders (chat, user_id, prompt, next_at) values ($1, $2, $3, now() + interval '2 days')",
    [B, PERSON, "transfer-check already waiting"],
  );
  const reminderRef = (await transfer.inventory(A)).find((i) => i.kind === "reminder")!;
  const clash = await transfer.transfer(A, B, [reminderRef.ref], "move");
  check("a reminder that would overwrite one is refused", clash[0]?.done === false);
  check("and says why", Boolean(clash[0]?.why), `— ${clash[0]?.why ?? ""}`);
  check(
    "the person's existing reminder is untouched",
    (
      await query<{ prompt: string }>(
        "select prompt from reminders where chat = $1 and user_id = $2",
        [B, PERSON],
      )
    )[0]?.prompt === "transfer-check already waiting",
  );
  check(
    "and the original is still where it was",
    (await transfer.inventory(A)).some((i) => i.kind === "reminder"),
  );

  // A Notion connection moves once, and never into a chat that already has one.
  const notionRef = (await transfer.inventory(A)).find((i) => i.kind === "notion")!;
  const notionMoved = await transfer.transfer(A, B, [notionRef.ref], "move");
  check("the Notion connection moves", notionMoved[0]?.done === true);
  check(
    "one grant stayed one grant",
    (await query("select chat from notion_connections where chat = any($1)", [[A, B]])).length === 1,
  );

  await query(
    "insert into notion_connections (chat, access_token, workspace_name) values ($1, $2, $3)",
    [C, "transfer-check-token-2", "Other"],
  );
  const second = await transfer.transfer(C, B, ["notion:"], "move");
  check("a second connection into the same group is refused", second[0]?.done === false);
  check("and says why", Boolean(second[0]?.why), `— ${second[0]?.why ?? ""}`);

  // ── guards ─────────────────────────────────────────────────────────────
  console.log("\nguards:");
  let sameRefused = false;
  try {
    await transfer.transfer(A, A, ["memory:1"], "move");
  } catch {
    sameRefused = true;
  }
  check("moving a group into itself is refused", sameRefused);

  const ghost = await transfer.transfer(A, B, ["memory:99999999"], "move");
  check("an item that is no longer there is reported, not thrown", ghost[0]?.done === false);

  const foreign = await transfer.transfer(A, B, ["task:not-a-number"], "move");
  check("a malformed reference cannot touch anything", foreign[0]?.done === false);
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
