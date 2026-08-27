import { wapi } from "@/lib/wapi";
import * as memory from "@/lib/memory";
import { query } from "@/lib/db";
import * as usage from "@/lib/usage";

/**
 * A status page, not an admin panel: is the session linked, who am I, what do I remember. It
 * exists so that after deploying you can tell at a glance whether the bot is actually wired up,
 * without opening a log.
 */

export const dynamic = "force-dynamic";

/**
 * Written for whoever opens this page, not for the model — the bot's own account of itself
 * lives in `lib/about.ts`. Phrased as what someone can ask for, since that is how it is used.
 */
const FEATURES: { title: string; detail: string }[] = [
  {
    title: "Answers when tagged",
    detail:
      "In groups only, when @-mentioned or when you reply to one of its messages. Direct chats are ignored, and so is everything else.",
  },
  {
    title: "Follows what you point at",
    detail:
      "Reply to any message and tag it, and it reads what you replied to — the text, and the picture if there is one. “What does this mean?” works.",
  },
  {
    title: "Reacts with emoji",
    detail:
      "Weighs up whether each message deserves a reaction, and picks one that fits — 😂 🎉 🔥 👀 — rather than defaulting to 👍.",
  },
  {
    title: "Searches the web",
    detail:
      "For anything current or specific enough that being wrong would matter — not for things it already knows.",
  },
  {
    title: "Keeps a checklist",
    detail:
      "Each chat has its own pending list. Add items, tick them off, take them back off the list — in whatever words you use for it.",
  },
  {
    title: "Remembers",
    detail:
      "“Record that…” keeps a fact for the chat; some facts can be saved for every chat. Both survive restarts, and “forget that” removes them.",
  },
  {
    title: "Sends files",
    detail: "Images, video, PDFs and other documents, found by searching or from a link you give it.",
  },
  {
    title: "Speaks",
    detail:
      "Generates a voice note when something is easier to hear than to read, or when you ask it to read something out.",
  },
  {
    title: "Runs polls",
    detail: "Puts a WhatsApp poll in the chat, two to twelve options, single or multiple choice.",
  },
  {
    title: "Collects stickers",
    detail:
      "Every sticker sent in any chat it is in is kept, silently and without replying. One shared library, described automatically so it can be found later.",
  },
  {
    title: "Makes stickers",
    detail:
      "Tag it with an image, GIF or short video, or give it a GIF link. Animation is preserved.",
  },
  {
    title: "Draws stickers",
    detail:
      "Ask for a sticker of something that does not exist and it draws one, on a transparent background.",
  },
  {
    title: "Names stickers",
    detail: "Tell it what one should be called and it can be asked for by that name afterwards.",
  },
  {
    title: "Reads and writes spreadsheets",
    detail:
      "Share a Google Sheets link and ask what is missing, or have it fill something in. Reading a public sheet needs no setup.",
  },
  {
    title: "Connects to Notion",
    detail:
      "Ask it to connect and it sends a link. You choose which pages it may reach; after that it can search, read, write, work with databases and leave comments there.",
  },
  {
    title: "Reports its usage",
    detail: "Tokens and estimated spend for today, the last week and all time.",
  },
  {
    title: "Knows what it is",
    detail: "Ask how it works, what it runs on, or who built it, and it answers from fact.",
  },
  {
    title: "Reconnects itself",
    detail:
      "Watches its own WhatsApp session and brings it back when it drops, so a restart underneath it goes unnoticed.",
  },
];

const settle = async <T,>(p: Promise<T>): Promise<T | null> =>
  p.catch(() => null);

export default async function Page() {
  const [status, me, memories, stickers, spend] = await Promise.all([
    settle(wapi.status()),
    settle(wapi.me()),
    settle(memory.list()),
    // The library is shared, so this is simply all of it.
    settle(
      query<{ id: number; label: string; url: string; chat: string; portable: boolean }>(
        "select id, label, url, chat, (bytes is not null) as portable from stickers order by id desc limit 60",
      ),
    ),
    settle(usage.summary()),
  ]);

  const connected = status === "connected";
  const tokens = (n: number) => n.toLocaleString("en-US");
  const money = (usd: number | null) =>
    usd === null ? "—" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;

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

      <h2>What it can do</h2>
      <div className="panel">
        <ul className="features">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <strong>{f.title}</strong>
              <span>{f.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <h2>Usage</h2>
      <div className="panel">
        {spend === null ? (
          <p className="empty">Could not read usage.</p>
        ) : spend.allTime.calls === 0 ? (
          <p className="empty">Nothing recorded yet.</p>
        ) : (
          <dl>
            {(
              [
                ["Today", spend.today],
                ["Last 7 days", spend.week],
                ["All time", spend.allTime],
              ] as const
            ).map(([label, t]) => (
              <div className="row" key={label}>
                <dt>{label}</dt>
                <dd>
                  {tokens(t.inputTokens + t.outputTokens)} tokens · {t.calls} calls ·{" "}
                  {money(t.estimatedUsd)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {spend?.allTime.estimatedUsd === null && spend.allTime.calls > 0 && (
          <p className="meta" style={{ marginTop: "0.6rem" }}>
            No published rate for this model — set <code>OPENAI_PRICE_INPUT</code> and{" "}
            <code>OPENAI_PRICE_OUTPUT</code> (USD per million tokens) to show cost.
          </p>
        )}
      </div>

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
