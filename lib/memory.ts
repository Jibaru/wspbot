import "server-only";
import { query } from "./db";

/**
 * Memory: one row per fact, scoped to the chat it was told in.
 *
 * Scoping is per chat rather than global so a fact told in one group does not leak into
 * another — the bot sits in shared rooms, and "we need a calendar schedule" belongs to the room
 * that said it. `GLOBAL` is for facts you set yourself and want everywhere.
 */

export const GLOBAL = "global";

export type Memory = {
  /** Shown to the model and to you as `m12`, so it can be referred to in plain language. */
  id: string;
  chat: string;
  text: string;
  author: string | null;
  createdAt: Date;
};

type Row = {
  id: number;
  chat: string;
  text: string;
  author: string | null;
  created_at: Date;
};

const toMemory = (row: Row): Memory => ({
  id: `m${row.id}`,
  chat: row.chat,
  text: row.text,
  author: row.author,
  createdAt: row.created_at,
});

/** `m12` → 12. Anything else is not an id, and must not become `NaN` in a query. */
const parseId = (id: string): number | null => {
  const digits = /^m?(\d+)$/.exec(id.trim());
  return digits?.[1] ? Number(digits[1]) : null;
};

/** Everything the given chat can see: its own facts plus the global ones. */
export const list = async (chat?: string): Promise<Memory[]> => {
  const rows = chat
    ? await query<Row>(
        "select * from memories where chat = $1 or chat = $2 order by id",
        [chat, GLOBAL],
      )
    : await query<Row>("select * from memories order by id");
  return rows.map(toMemory);
};

export const add = async (
  chat: string,
  text: string,
  author?: string,
): Promise<Memory> => {
  const rows = await query<Row>(
    "insert into memories (chat, text, author) values ($1, $2, $3) returning *",
    [chat, text.trim(), author ?? null],
  );
  return toMemory(rows[0]!);
};

/**
 * Removal is scoped: passing `chat` stops one room from deleting another room's facts, which
 * matters because the model calls this on behalf of whoever is talking.
 */
export const remove = async (
  id: string,
  chat?: string,
): Promise<Memory | null> => {
  const numeric = parseId(id);
  if (numeric === null) return null;

  const rows = chat
    ? await query<Row>(
        "delete from memories where id = $1 and (chat = $2 or chat = $3) returning *",
        [numeric, chat, GLOBAL],
      )
    : await query<Row>("delete from memories where id = $1 returning *", [
        numeric,
      ]);
  return rows[0] ? toMemory(rows[0]) : null;
};

export const clear = async (chat?: string): Promise<number> => {
  const rows = chat
    ? await query<Row>("delete from memories where chat = $1 returning id", [
        chat,
      ])
    : await query<Row>("delete from memories returning id");
  return rows.length;
};

/** Rendered into the system prompt, so the bot recalls without having to call a tool first. */
export const render = (memories: Memory[]): string =>
  memories.length === 0
    ? "(nothing remembered yet)"
    : memories
        .map(
          (m) =>
            // Marked so the model can tell a fact about this room from one that applies to all.
            `- [${m.id}]${m.chat === GLOBAL ? " (everywhere)" : ""} ${m.text}${m.author ? ` — said by ${m.author}` : ""} (${m.createdAt.toISOString().slice(0, 10)})`,
        )
        .join("\n");
