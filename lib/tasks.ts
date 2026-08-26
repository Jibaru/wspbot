import "server-only";
import { query } from "./db";

/**
 * The chat's checklist.
 *
 * Scoped per chat, like memories: a group's pending list belongs to that group. Rendered into
 * the system prompt on every turn so "what's left?" is answered from what the model already has,
 * the same trick memories use — a list nobody can see without a tool call is a list nobody uses.
 *
 * Ids are shown as `t3` so someone can say "check off t3", but the model is told to accept plain
 * language too: people say "mark the milk one done", not an id.
 */

export type Task = {
  id: string;
  text: string;
  done: boolean;
  addedBy: string | null;
  doneBy: string | null;
};

type Row = {
  id: number;
  text: string;
  done: boolean;
  added_by: string | null;
  done_by: string | null;
};

const toTask = (row: Row): Task => ({
  id: `t${row.id}`,
  text: row.text,
  done: row.done,
  addedBy: row.added_by,
  doneBy: row.done_by,
});

/** Enough that a real list fits, few enough that a runaway one cannot swamp the prompt. */
const OPEN_LIMIT = 40;

/** A little history, so "did we do the invoices?" is answerable without a lookup. */
const DONE_LIMIT = 5;

const parseId = (id: string): number | null => {
  const digits = /^t?(\d+)$/.exec(id.trim());
  return digits?.[1] ? Number(digits[1]) : null;
};

export const open = async (chat: string): Promise<Task[]> => {
  const rows = await query<Row>(
    "select id, text, done, added_by, done_by from tasks where chat = $1 and not done order by id limit $2",
    [chat, OPEN_LIMIT],
  );
  return rows.map(toTask);
};

export const recentlyDone = async (chat: string): Promise<Task[]> => {
  const rows = await query<Row>(
    "select id, text, done, added_by, done_by from tasks where chat = $1 and done order by done_at desc limit $2",
    [chat, DONE_LIMIT],
  );
  return rows.map(toTask);
};

/** Several at once, because people list things: "add milk, eggs and bread". */
export const add = async (
  chat: string,
  texts: string[],
  addedBy: string,
): Promise<Task[]> => {
  const cleaned = texts.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const values = cleaned.map((_, i) => `($1, $${i + 3}, $2)`).join(", ");
  const rows = await query<Row>(
    `insert into tasks (chat, text, added_by) values ${values}
     returning id, text, done, added_by, done_by`,
    [chat, addedBy, ...cleaned],
  );
  return rows.map(toTask);
};

/**
 * Marking done is scoped to the chat so one room cannot tick off another's list, and returns
 * what it actually changed — the caller needs to know an id was wrong rather than assume.
 */
export const setDone = async (
  chat: string,
  ids: string[],
  done: boolean,
  doneBy: string,
): Promise<Task[]> => {
  const numeric = ids.map(parseId).filter((n): n is number => n !== null);
  if (numeric.length === 0) return [];

  const rows = await query<Row>(
    `update tasks
        set done = $3,
            done_at = case when $3 then now() else null end,
            done_by = case when $3 then $4 else null end
      where chat = $1 and id = any($2::int[])
      returning id, text, done, added_by, done_by`,
    [chat, numeric, done, doneBy],
  );
  return rows.map(toTask);
};

export const remove = async (chat: string, ids: string[]): Promise<Task[]> => {
  const numeric = ids.map(parseId).filter((n): n is number => n !== null);
  if (numeric.length === 0) return [];

  const rows = await query<Row>(
    `delete from tasks where chat = $1 and id = any($2::int[])
     returning id, text, done, added_by, done_by`,
    [chat, numeric],
  );
  return rows.map(toTask);
};

/** Clearing the finished ones is the tidy-up people actually ask for. */
export const clearDone = async (chat: string): Promise<number> => {
  const rows = await query("delete from tasks where chat = $1 and done returning id", [chat]);
  return rows.length;
};

/**
 * Rendered into the system prompt. Open items first with their ids, then a short tail of
 * finished ones so recent history is answerable without another query.
 */
export const render = (openTasks: Task[], doneTasks: Task[]): string => {
  if (openTasks.length === 0 && doneTasks.length === 0) return "(the list is empty)";

  const lines = [
    ...openTasks.map((t) => `- [${t.id}] ${t.text}`),
    ...doneTasks.map((t) => `- [${t.id}] ~${t.text}~ (done${t.doneBy ? ` by ${t.doneBy}` : ""})`),
  ];
  if (openTasks.length === 0) lines.unshift("(nothing open)");
  return lines.join("\n");
};
