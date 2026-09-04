import "server-only";
import { query } from "./db";
import * as supporters from "./supporters";

/**
 * What gets built next, ranked by the people paying for it.
 *
 * Voting never turns anything on by itself — the `features` table is global, so an "unlock" by one
 * supporter would switch a feature on for every group the bot sits in. This produces a ranked
 * list; a human still builds the thing. That is the whole claim, and it is worth being plain
 * about, because a roadmap that quietly shipped features would be a different and worse product.
 *
 * A vote's weight is looked up at tally time rather than stored on the vote, so buying another
 * coffee strengthens every vote you already hold instead of needing a backfill.
 */

export type State = "proposed" | "open" | "shipped" | "declined";

export type Item = {
  id: number;
  title: string;
  detail: string | null;
  state: State;
  proposedBy: string | null;
  createdAt: Date;
  settledAt: Date | null;
  /** Sum of the weights behind it, not a headcount. */
  weight: number;
  /** How many people, which is the other half of "3 backers, 11 points". */
  backers: number;
};

/**
 * How many things one supporter may be waiting on at once.
 *
 * Without a cap everyone votes for everything and the ranking collapses into "sum of all
 * supporters", which ranks nothing. Three is small enough to force a choice and large enough that
 * the choice is not agonising.
 */
export const MAX_OPEN_VOTES = 3;

type Row = {
  id: number;
  title: string;
  detail: string | null;
  state: string;
  proposed_by: string | null;
  created_at: Date;
  settled_at: Date | null;
  weight: string | null;
  backers: string | null;
};

const toItem = (row: Row): Item => ({
  id: row.id,
  title: row.title,
  detail: row.detail,
  state: (["proposed", "open", "shipped", "declined"].includes(row.state)
    ? row.state
    : "proposed") as State,
  proposedBy: row.proposed_by,
  createdAt: row.created_at,
  settledAt: row.settled_at,
  // `sum` and `count` come back from pg as strings; compared as numbers they would be false.
  weight: Number(row.weight ?? 0),
  backers: Number(row.backers ?? 0),
});

/**
 * Every item, with its tally.
 *
 * The weight is joined from `supporters` rather than read off the vote, so another coffee
 * strengthens every vote already held and a removed supporter takes their weight out with them —
 * the cascade deletes their votes, which is the same answer `weightFor` gives in TypeScript.
 *
 * Votes key on the supporter, never on the identity they happened to use. One person holding both
 * a LID and a username would otherwise be able to back the same item twice.
 */
const SELECT = `
  select i.id, i.title, i.detail, i.state, i.proposed_by, i.created_at, i.settled_at,
         coalesce(sum(least(greatest(s.coffees, 0), $1)), 0)::text as weight,
         count(s.id)::text                                        as backers
    from roadmap_items i
    left join roadmap_votes v on v.item_id = i.id
    left join supporters s on s.id = v.supporter_id
   group by i.id`;

export const list = async (states?: State[]): Promise<Item[]> => {
  const rows = await query<Row>(
    `${SELECT} ${states ? "having i.state = any($2)" : ""}
     order by
       case i.state when 'open' then 0 when 'proposed' then 1 when 'shipped' then 2 else 3 end,
       coalesce(sum(least(greatest(s.coffees, 0), $1)), 0) desc,
       i.created_at`,
    states ? [supporters.MAX_WEIGHT, states] : [supporters.MAX_WEIGHT],
  );
  return rows.map(toItem);
};

export const byId = async (id: number): Promise<Item | null> => {
  const rows = await query<Row>(`${SELECT} having i.id = $2`, [supporters.MAX_WEIGHT, id]);
  return rows[0] ? toItem(rows[0]) : null;
};

export const add = async (input: {
  title: string;
  detail?: string | null;
  state?: State;
  proposedBy?: string | null;
}): Promise<number> => {
  const rows = await query<{ id: number }>(
    `insert into roadmap_items (title, detail, state, proposed_by)
     values ($1, $2, $3, $4) returning id`,
    [input.title.trim(), input.detail?.trim() || null, input.state ?? "proposed", input.proposedBy ?? null],
  );
  return rows[0]!.id;
};

/** Approving, declining or shipping. `settled_at` is stamped for anything that is finished. */
export const setState = (id: number, state: State): Promise<unknown[]> =>
  query(
    `update roadmap_items
        set state = $2,
            settled_at = case when $2 in ('shipped', 'declined') then now() else null end
      where id = $1`,
    [id, state],
  );

export const remove = (id: number): Promise<unknown[]> =>
  query("delete from roadmap_items where id = $1", [id]);

/** What one person is currently waiting on. Finished items do not count against the cap. */
export const openVotesOf = async (supporterId: number): Promise<Item[]> => {
  const rows = await query<Row>(
    `${SELECT} having i.state = 'open' and bool_or(v.supporter_id = $2)`,
    [supporters.MAX_WEIGHT, supporterId],
  );
  return rows.map(toItem);
};

export type VoteOutcome =
  | { ok: true; item: Item; weight: number }
  | { ok: false; why: string; holding?: Item[] };

/**
 * Cast a vote.
 *
 * Every refusal returns a reason meant to be read aloud in a chat, because that is where this is
 * used — a boolean would leave the model to invent an explanation.
 */
export const vote = async (handle: string, itemId: number): Promise<VoteOutcome> => {
  const supporter = await supporters.byHandle(handle);
  const weight = supporters.weightFor(supporter);
  if (!supporter || weight <= 0) {
    return { ok: false, why: "only supporters can vote" };
  }

  const item = await byId(itemId);
  if (!item) return { ok: false, why: "there is no item with that number" };
  if (item.state !== "open") {
    return {
      ok: false,
      why:
        item.state === "proposed"
          ? "that one is still waiting to be approved"
          : `that one is already ${item.state}`,
    };
  }

  const holding = await openVotesOf(supporter.id);
  if (holding.some((h) => h.id === itemId)) {
    // Not an error worth a refusal — they already have what they asked for.
    return { ok: true, item, weight };
  }
  if (holding.length >= MAX_OPEN_VOTES) {
    return {
      ok: false,
      why: `you are already backing ${MAX_OPEN_VOTES} open items — drop one first`,
      holding,
    };
  }

  await query(
    "insert into roadmap_votes (item_id, supporter_id) values ($1, $2) on conflict do nothing",
    [itemId, supporter.id],
  );
  return { ok: true, item: (await byId(itemId))!, weight };
};

/** Taking a vote back, by any identity that belongs to the person who cast it. */
export const unvote = async (handle: string, itemId: number): Promise<boolean> => {
  const supporter = await supporters.byHandle(handle);
  if (!supporter) return false;
  const rows = await query(
    "delete from roadmap_votes where item_id = $1 and supporter_id = $2 returning item_id",
    [itemId, supporter.id],
  );
  return rows.length > 0;
};

/**
 * The list as the bot reads it out.
 *
 * Numbers rather than ids: the model is asked to cite an item and answers with the small number it
 * can see, which is the same lesson the digest's picture numbering taught. The mapping comes back
 * in the same call so the two cannot drift.
 */
export const render = (
  items: Item[],
): { text: string; numbering: Map<number, number> } => {
  const open = items.filter((i) => i.state === "open");
  const shipped = items.filter((i) => i.state === "shipped");
  const numbering = new Map<number, number>();

  const lines: string[] = [];

  if (open.length === 0) {
    lines.push("Nothing on the roadmap yet.");
  } else {
    lines.push("Being considered, most backed first:");
    open.forEach((item, index) => {
      numbering.set(index + 1, item.id);
      const backing =
        item.backers === 0
          ? "no backers yet"
          : `${item.weight} point${item.weight === 1 ? "" : "s"} from ${item.backers} supporter${item.backers === 1 ? "" : "s"}`;
      lines.push(`${index + 1}. ${item.title} — ${backing}`);
    });
  }

  if (shipped.length > 0) {
    lines.push("", "Already shipped:");
    for (const item of shipped.slice(0, 5)) {
      lines.push(
        `- ${item.title}${item.backers > 0 ? ` (backed by ${item.backers})` : ""}`,
      );
    }
  }

  return { text: lines.join("\n"), numbering };
};
