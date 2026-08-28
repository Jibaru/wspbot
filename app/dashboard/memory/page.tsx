import * as memory from "@/lib/memory";
import { settle, when } from "../shared";
import { forgetMemory } from "./actions";

/**
 * What the bot has been told to remember.
 *
 * Grouped by chat, with the global facts first: those are read in every conversation, so they
 * are the ones worth checking, and burying them among per-chat notes is how a stale standing
 * instruction survives unnoticed.
 */

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const all = await settle(memory.list());

  const groups = new Map<string, memory.Memory[]>();
  for (const m of all ?? []) {
    const key = m.chat === memory.GLOBAL ? memory.GLOBAL : m.chat;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === memory.GLOBAL ? -1 : b === memory.GLOBAL ? 1 : a.localeCompare(b),
  );

  return (
    <>
      <p className="lede">
        Read into the system prompt on every turn, so recall never depends on the bot deciding to
        look something up. Facts marked <em>everywhere</em> are in front of it in every chat.
      </p>

      {all === null ? (
        <>
          <h2>Memory</h2>
          <div className="panel">
            <p className="empty">
              Could not reach the database — check <code>DATABASE_URL</code>.
            </p>
          </div>
        </>
      ) : ordered.length === 0 ? (
        <>
          <h2>Memory</h2>
          <div className="panel">
            <p className="empty">
              Nothing remembered yet. Tag the bot and say “record that…”.
            </p>
          </div>
        </>
      ) : (
        ordered.map(([chat, items]) => (
          <div key={chat}>
            <h2>
              {chat === memory.GLOBAL ? "Everywhere" : chat} · {items.length}
            </h2>
            <div className="panel">
              <ul className="rows">
                {items.map((m) => (
                  <li key={m.id}>
                    <div className="grow">
                      {m.text}
                      <span className="meta">
                        <code>{m.id}</code>
                        {m.author ? ` · ${m.author}` : ""} · {when(m.createdAt)}
                      </span>
                    </div>
                    <form action={forgetMemory}>
                      <input type="hidden" name="id" value={m.id} />
                      <button type="submit" className="linky danger">
                        Forget
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))
      )}
    </>
  );
}
