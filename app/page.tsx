import { wapi } from "@/lib/wapi";
import * as memory from "@/lib/memory";
import { query } from "@/lib/db";

/**
 * A status page, not an admin panel: is the session linked, who am I, what do I remember. It
 * exists so that after deploying you can tell at a glance whether the bot is actually wired up,
 * without opening a log.
 */

export const dynamic = "force-dynamic";

const settle = async <T,>(p: Promise<T>): Promise<T | null> =>
  p.catch(() => null);

export default async function Page() {
  const [status, me, memories, stickers] = await Promise.all([
    settle(wapi.status()),
    settle(wapi.me()),
    settle(memory.list()),
    // The library is shared, so this is simply all of it.
    settle(
      query<{ id: number; label: string; url: string; chat: string; portable: boolean }>(
        "select id, label, url, chat, (bytes is not null) as portable from stickers order by id desc limit 60",
      ),
    ),
  ]);

  const connected = status === "connected";

  return (
    <main>
      <h1>wspbot</h1>
      <p className="lede">
        Answers when you tag it in WhatsApp. Searches the web, and remembers what
        you ask it to.
      </p>

      <h2>Session</h2>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>Status</dt>
            <dd className={connected ? "ok" : "bad"}>
              {status ?? "unreachable"}
            </dd>
          </div>
          <div className="row">
            <dt>Identity</dt>
            <dd>{me?.name?.trim() || me?.id || "—"}</dd>
          </div>
          <div className="row">
            <dt>JID</dt>
            <dd>
              <code>{me?.id ?? "—"}</code>
            </dd>
          </div>
          <div className="row">
            <dt>LID</dt>
            <dd>
              <code>{me?.lid ?? "—"}</code>
            </dd>
          </div>
          <div className="row">
            <dt>Webhook</dt>
            <dd>
              <code>/api/wapi/webhook</code>
            </dd>
          </div>
        </dl>
      </div>

      {!connected && (
        <p className="lede" style={{ marginTop: "1rem" }}>
          {status === null
            ? "Could not reach wapi — check WAPI_API_KEY."
            : "Link the phone from the wapi dashboard, then reload."}
        </p>
      )}

      <h2>Stickers{stickers?.length ? ` · ${stickers.length}` : ""}</h2>
      <div className="panel">
        {stickers === null ? (
          <p className="empty">Could not read the sticker library.</p>
        ) : stickers.length === 0 ? (
          <p className="empty">
            None yet. Send a sticker in any chat the bot is in, or tag it with an image.
          </p>
        ) : (
          <ul className="stickers">
            {stickers.map((s) => (
              <li key={s.id} title={`s${s.id} · first seen in ${s.chat}${s.portable ? "" : " · no local copy"}`}>
                {/* Plain img: these are wapi-hosted webp, and next/image would only add a proxy. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.label} loading="lazy" />
                <span>{s.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Memory{memories?.length ? ` · ${memories.length}` : ""}</h2>
      <div className="panel">
        {memories === null ? (
          <p className="empty">
            Could not reach the database — check <code>DATABASE_URL</code>.
          </p>
        ) : memories.length === 0 ? (
          <p className="empty">
            Nothing remembered yet. Tag the bot and say “record that…”.
          </p>
        ) : (
          <ul className="memories">
            {memories.map((m) => (
              <li key={m.id}>
                {m.text}
                <span className="meta">
                  <code>{m.id}</code> · {m.chat === memory.GLOBAL ? "everywhere" : m.chat}
                  {m.author ? ` · ${m.author}` : ""} ·{" "}
                  {m.createdAt.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
