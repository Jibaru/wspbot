import "server-only";
import { query } from "./db";
import { GLOBAL } from "./memory";

/**
 * Moving a group's context into another group.
 *
 * Groups get remade — a new one for the same team, a project room that supersedes a channel, a
 * chat someone had to recreate because WhatsApp lost it. Everything the bot had learned stayed
 * behind, and there was no way to bring it across short of typing it all in again.
 *
 * **Dashboard only, and deliberately so.** There is no tool for this, for the same reason there
 * is no tool for changing a rate limit: an ability the bot has is an ability anyone in a chat can
 * ask it to use, and "move that group's notes into this one" is not a request the bot is in any
 * position to judge. Whoever holds the sign-in decides.
 *
 * What moves is what somebody curated: facts, checklist items, scheduled reminders, and the
 * Notion connection. What does not move is recorded rather than curated — the conversation
 * history, the logged transcript, usage, quotas — plus the sticker library, which is shared by
 * every chat already and so has nothing to move.
 */

export type Kind = "memory" | "task" | "reminder" | "notion";

export type Item = {
  /**
   * Identifies one thing across the two requests this takes — list it, then move it. Kind and
   * key rather than a bare row id, so a checkbox can never name a row of the wrong table.
   */
  ref: string;
  kind: Kind;
  label: string;
  detail: string | null;
  /**
   * True when the destination can hold only one of these. A reminder is keyed on the pair of
   * chat and person, and a Notion connection on the chat alone, so either can collide with
   * something already there.
   */
  singular: boolean;
};

export type Mode = "move" | "copy";

export type Outcome = {
  ref: string;
  label: string;
  done: boolean;
  /** Why it did not happen, in words meant for the person who asked. */
  why?: string;
};

const ref = (kind: Kind, key: string): string => `${kind}:${key}`;

const parseRef = (value: string): { kind: Kind; key: string } | null => {
  const at = value.indexOf(":");
  if (at < 0) return null;
  const kind = value.slice(0, at) as Kind;
  if (!["memory", "task", "reminder", "notion"].includes(kind)) return null;
  return { kind, key: value.slice(at + 1) };
};

/** Enough of a fact or an item to recognise it, without letting one long note fill the page. */
const trim = (text: string, max = 120): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Everything in this chat that could go somewhere else.
 *
 * Facts marked global are left out: they are already known in every chat, so they belong to no
 * group and there is nothing to move them to.
 */
export const inventory = async (chat: string): Promise<Item[]> => {
  const [memories, tasks, reminders, notion] = await Promise.all([
    query<{ id: number; text: string; author: string | null; created_at: Date }>(
      "select id, text, author, created_at from memories where chat = $1 and chat <> $2 order by id",
      [chat, GLOBAL],
    ),
    query<{ id: number; text: string; done: boolean; added_by: string | null }>(
      "select id, text, done, added_by from tasks where chat = $1 order by done, id",
      [chat],
    ),
    query<{ user_id: string; prompt: string; asked_by: string | null; next_at: Date }>(
      "select user_id, prompt, asked_by, next_at from reminders where chat = $1 order by next_at",
      [chat],
    ),
    query<{ workspace_name: string | null; connected_by: string | null }>(
      "select workspace_name, connected_by from notion_connections where chat = $1",
      [chat],
    ),
  ]);

  return [
    ...memories.map((m) => ({
      ref: ref("memory", String(m.id)),
      kind: "memory" as const,
      label: trim(m.text),
      detail: [m.author, m.created_at.toISOString().slice(0, 10)].filter(Boolean).join(" · "),
      singular: false,
    })),
    ...tasks.map((t) => ({
      ref: ref("task", String(t.id)),
      kind: "task" as const,
      label: trim(t.text),
      detail: [t.done ? "done" : "open", t.added_by].filter(Boolean).join(" · "),
      singular: false,
    })),
    ...reminders.map((r) => ({
      ref: ref("reminder", r.user_id),
      kind: "reminder" as const,
      label: trim(r.prompt),
      detail: [r.asked_by ?? r.user_id.replace(/@.*$/, ""), r.next_at.toISOString().slice(0, 16).replace("T", " ")]
        .filter(Boolean)
        .join(" · "),
      singular: true,
    })),
    ...notion.map((n) => ({
      ref: ref("notion", ""),
      kind: "notion" as const,
      label: `Notion workspace${n.workspace_name ? ` — ${n.workspace_name}` : ""}`,
      detail: n.connected_by ? `connected by ${n.connected_by}` : null,
      singular: true,
    })),
  ];
};

/**
 * Carry the chosen things across.
 *
 * Each item is its own statement rather than one transaction, so a collision on one reminder
 * does not roll back the twelve notes that moved cleanly. The cost is that a partial result is
 * possible — which is why every item comes back with an outcome rather than the whole thing
 * returning a single boolean.
 */
export const transfer = async (
  from: string,
  to: string,
  refs: string[],
  mode: Mode,
): Promise<Outcome[]> => {
  if (from === to) throw new Error("source and destination are the same chat");

  const items = await inventory(from);
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const outcomes: Outcome[] = [];

  for (const value of refs) {
    const item = byRef.get(value);
    const parsed = parseRef(value);
    // Something that is no longer there — deleted between listing the page and submitting it.
    if (!item || !parsed) {
      outcomes.push({ ref: value, label: value, done: false, why: "no longer in that group" });
      continue;
    }

    try {
      const done = await one(parsed.kind, parsed.key, from, to, mode);
      outcomes.push({ ref: value, label: item.label, ...done });
    } catch (err) {
      outcomes.push({
        ref: value,
        label: item.label,
        done: false,
        why: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
};

const one = async (
  kind: Kind,
  key: string,
  from: string,
  to: string,
  mode: Mode,
): Promise<{ done: boolean; why?: string }> => {
  const id = Number(key);

  if (kind === "memory") {
    if (mode === "copy") {
      await query(
        "insert into memories (chat, text, author) select $2, text, author from memories where id = $1 and chat = $3",
        [id, to, from],
      );
    } else {
      await query("update memories set chat = $2 where id = $1 and chat = $3", [id, to, from]);
    }
    return { done: true };
  }

  if (kind === "task") {
    if (mode === "copy") {
      await query(
        "insert into tasks (chat, text, done, added_by, done_by, done_at) select $2, text, done, added_by, done_by, done_at from tasks where id = $1 and chat = $3",
        [id, to, from],
      );
    } else {
      await query("update tasks set chat = $2 where id = $1 and chat = $3", [id, to, from]);
    }
    return { done: true };
  }

  if (kind === "reminder") {
    /*
     * One reminder per person per chat, enforced by the primary key. Somebody who already has one
     * waiting in the destination would have it silently replaced, so this refuses instead — the
     * person's own reminder is not the dashboard's to overwrite.
     */
    const clash = await query<{ user_id: string }>(
      "select user_id from reminders where chat = $1 and user_id = $2",
      [to, key],
    );
    if (clash.length > 0) {
      return { done: false, why: "that person already has a reminder in the destination" };
    }

    if (mode === "copy") {
      await query(
        `insert into reminders (chat, user_id, prompt, asked_by, next_at, every_minutes, max_runs)
         select $2, user_id, prompt, asked_by, next_at, every_minutes, max_runs
           from reminders where chat = $3 and user_id = $1`,
        [key, to, from],
      );
    } else {
      await query("update reminders set chat = $2 where chat = $3 and user_id = $1", [
        key,
        to,
        from,
      ]);
    }
    return { done: true };
  }

  // Notion.
  const clash = await query<{ chat: string }>(
    "select chat from notion_connections where chat = $1",
    [to],
  );
  if (clash.length > 0) {
    return { done: false, why: "the destination is already connected to a workspace" };
  }
  /*
   * Moved, never copied. Somebody authorised this workspace for one conversation; carrying that
   * grant to a second room while leaving it in the first turns one consent into two, which is
   * not a thing an administrator should be able to do by ticking a box.
   */
  await query("update notion_connections set chat = $2 where chat = $1", [from, to]);
  return { done: true };
};

/**
 * What deliberately stays put, and why. Shown on the page, because "everything moved" and
 * "everything I chose moved" are different claims and the page should not imply the first.
 */
export const IMMOVABLE: { what: string; why: string }[] = [
  {
    what: "Conversation history",
    why: "It is a record of what was said in that room, not something anyone curated. Splicing it into another group would have the bot remembering saying things it never said there.",
  },
  {
    what: "Recorded messages for digests",
    why: "Same reason, and they are pruned within a fortnight anyway.",
  },
  {
    what: "The sticker library",
    why: "Already shared by every chat — there is nothing to move.",
  },
  {
    what: "Usage and rate limits",
    why: "Accounting, and quotas belong to a person rather than to a group.",
  },
  {
    what: "Summary schedules",
    why: "Point one at the new group on the Summaries page instead; a schedule is a pair of rooms, not a thing inside one.",
  },
];
