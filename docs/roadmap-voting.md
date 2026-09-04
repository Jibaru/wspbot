# Supporter-weighted roadmap voting

**Status: built and deployed.** Kept as the record of why it is shaped this way; the code is the
authority on what it does.

Supporters influence what gets built next by voting, weighted by how much they have supported.
They can also propose items. Separately, being a supporter raises your rate limit.

---

## What this is, and what it deliberately is not

Three readings of "supporters can add more features" were on the table. Only one survived:

| | |
| --- | --- |
| **Vote on the roadmap** | ✅ What this is. Points rank a list; a human still builds the thing. |
| Unlock existing features | ❌ Rejected. `features` is keyed on `key` alone — **global** — so one supporter "unlocking" summaries turns it on for every group the bot sits in, including people who never asked. Making it per-chat is a real architectural change for a perk nobody requested. |
| More capacity | ✅ But only as the perk: a higher rate limit. Scoped to a person by construction, and `rate_limits` already is. |

Voting **never** turns a feature on by itself. It produces a ranked list.

---

## The weight

The supporters table holds **no amounts**, by an earlier deliberate choice — the page promises
"names and how they helped, never amounts". Weighted voting needs a number, so weight comes from a
**coffee count**, not money.

- Buy Me a Coffee supplies `support_coffees` in the payload already.
- Yape supplies nothing, so you type a count in: *"she sent S/20, call it 4."* The conversion stays
  your judgement rather than an exchange rate in code.

```ts
/** The only place the arithmetic happens. Pure, so the check drives it with no database. */
export const weightFor = (supporter: Supporter | null): number =>
  supporter ? Math.min(supporter.coffees, MAX_WEIGHT) : 0;
```

`MAX_WEIGHT = 5`. The cap exists so one person buying fifty coffees cannot own the roadmap
outright. **Gratitude stays uncapped** — the supporters list keeps showing the true count — only
influence saturates. Chosen over a square root because *"your vote counts as five, the most anyone
gets"* is one sentence and `√17 ≈ 4.12` is not.

**No decay.** A coffee from last year still counts. Decay needs a recompute on a timer, a rule to
explain in a chat message, and it quietly tells past supporters their contribution expired.
Revisit only if the list reaches a size where someone is coasting.

---

## Voting rules

- **Standing weight, not a spent budget.** Your vote carries your full weight; there is no ledger,
  no refunds, no "how many points do I have left" conversation.
- **At most three open votes** per supporter. A fourth asks them to drop one. This is what stops
  everyone voting for everything and the ranking collapsing into "sum of all supporters".
- **A shipped or declined item frees its slot.** The cap means "three things you are waiting on",
  not "three things ever".
- **Votes on finished items are kept**, so the page can say *"shipped, backed by 4"* — the most
  persuasive thing a roadmap can show someone deciding whether to support.
- **One vote per person per item**, enforced by a unique constraint. Voting twice must not double
  the weight; this is the bug most likely to ship silently.

---

## Item lifecycle

```
proposed ──(you approve on the dashboard)──▶ open ──▶ shipped
    │                                          │
    └──────(you decline)───────────────────────┴──▶ declined
```

Supporters propose through the bot; items become votable only once you accept them. This honours
"supporters can add" literally while keeping the list yours, and the moderation surface is five
people rather than the internet.

---

## Schema

```sql
-- Weight, on the existing supporters table.
alter table supporters add column if not exists coffees integer not null default 1;

create table if not exists roadmap_items (
  id          serial primary key,
  title       text        not null,
  detail      text,
  -- proposed | open | shipped | declined
  state       text        not null default 'proposed',
  -- Who suggested it, as a normalised handle. Null when you added it yourself.
  proposed_by text,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);
create index if not exists roadmap_items_state_idx on roadmap_items (state);

create table if not exists roadmap_votes (
  item_id  integer     not null references roadmap_items (id) on delete cascade,
  -- The supporter's normalised handle, the same shape mentions.identityKey produces.
  handle   text        not null,
  at       timestamptz not null default now(),
  -- One vote per person per item. Without this, voting twice doubles the weight silently.
  primary key (item_id, handle)
);
```

Weight is **not** stored on the vote. It is looked up at tally time, so buying another coffee
retroactively strengthens every vote you already hold — which is the behaviour people expect and
the alternative would need a backfill.

---

## The bot's surface

One switch, `roadmap`, owning three tools — narrow names rather than one tool with a mode
argument, because that is how the other 33 read and the model picks better from clear names.

| Tool | Does |
| --- | --- |
| `list_roadmap` | What is being built, ranked, with vote counts. Anyone may ask. |
| `vote_roadmap` | Back an item. Refuses a fourth and says which three are held. |
| `propose_roadmap` | A supporter's suggestion, stored as `proposed` for your approval. |

**A non-supporter** gets the roadmap named, a plain statement that voting is weighted by support,
the coffee link once, and then it is dropped. No nagging, no repeating next time.

**A supporter whose handle is not tied** is indistinguishable from a non-supporter — the bot
cannot know. The fix is procedural: tying a handle belongs in the routine when you add someone, and
the dashboard should make an untied supporter visually obvious.

---

## The perk

Supporter status raises the rate limit **computed, not stored**:

- `quotaFor` in `lib/rate-limit.ts` already is the single place the allowance is decided, and it
  runs before anything costs money.
- An explicit `rate_limits` row still wins, so you can override.
- Removing someone as a supporter reverses the perk immediately. A stored row would leave a removed
  supporter quietly keeping it — the sort of thing nobody notices for a year.

---

## Where it shows

- **`/dashboard/roadmap`** — approve or decline proposals, add items, mark shipped, see the tally.
- **The landing page**, as a block under Open source, beside the coffee link it is arguing for.
  **Items and counts public; voter names never** — naming who voted turns a small group's
  preferences into a public record.

`/` is currently statically prerendered. The block makes it database-backed, so it gets
`export const revalidate = 300`: counts at most five minutes stale, the page stays fast, and the
one route that survives Postgres being down keeps surviving it.

---

## Files

| | |
| --- | --- |
| `lib/roadmap.ts` | new — items, votes, tally, the cap |
| `lib/supporters.ts` | `coffees`, and `weightFor` |
| `lib/rate-limit.ts` | `quotaFor` consults supporters |
| `lib/features.ts` | one `roadmap` entry owning three tools |
| `lib/agent.ts` | the three tools and their prompt section |
| `lib/about.ts` | that a roadmap exists and how voting works |
| `app/dashboard/roadmap/` | page + actions |
| `app/dashboard/supporters/page.tsx` | a coffees field |
| `app/page.tsx` | the public block |
| `lib/db.ts` | the DDL above |
| `scripts/roadmap-check.mts` | new |

---

## The check

`npm run roadmap-check`, against the real database on throwaway rows:

- a supporter's weight is their coffee count
- a whale's weight saturates at five
- a non-supporter weighs nothing, and their vote is refused
- a fourth vote is refused while three are open
- a shipped item frees its slot
- the tally sums **weights**, not heads
- **voting twice for the same item does not double it**
- a proposal is not votable until approved

---

## Known risks

1. **Five supporters is a small electorate.** With this few people the ranking is closer to a
   conversation than a vote. The cap and the weighting only start earning their keep at perhaps
   twenty. Worth building anyway — as an argument for supporting, it works from day one.
2. **The perk is invisible until someone hits a limit.** A higher rate limit is a real benefit
   nobody experiences. The roadmap vote is the part supporters will actually feel.
3. **An untied handle silently degrades to non-supporter.** Mitigated procedurally, not
   technically; there is no way for the bot to guess.
