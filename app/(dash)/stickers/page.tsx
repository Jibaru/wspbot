import * as stickers from "@/lib/stickers";
import { settle } from "../shared";
import { renameSticker, deleteSticker } from "./actions";

/**
 * The sticker library, which is shared by every chat — a sticker collected in one group can be
 * sent in another. The chat shown against each is where it was first seen, and nothing more.
 */

export const dynamic = "force-dynamic";

export default async function StickersPage() {
  const library = await settle(stickers.list());

  return (
    <>
      <p className="lede">
        Collected silently from every chat the bot is in, and shared across all of them. The name
        is what the bot matches on when someone asks for one, so a good name is worth more here
        than anywhere else.
      </p>

      <h2>Library{library?.length ? ` · ${library.length}` : ""}</h2>
      <div className="panel">
        {library === null ? (
          <p className="empty">Could not read the sticker library.</p>
        ) : library.length === 0 ? (
          <p className="empty">
            None yet. Send a sticker in any chat the bot is in, or tag it with an image.
          </p>
        ) : (
          <ul className="sticker-rows">
            {library.map((s) => (
              <li key={s.id}>
                {/* Plain img: these are wapi-hosted webp, and next/image would only add a proxy. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.label} loading="lazy" />
                <div className="sticker-body">
                  <form action={renameSticker} className="rename">
                    <input type="hidden" name="id" value={s.id} />
                    <input
                      type="text"
                      name="label"
                      defaultValue={s.label}
                      aria-label={`Name of sticker ${s.id}`}
                    />
                    <button type="submit">Rename</button>
                  </form>
                  <span className="meta">
                    <code>{s.id}</code> · first seen in {s.chat}
                    {s.hasBytes ? "" : " · no local copy"}
                    {s.description ? ` · ${s.description}` : ""}
                  </span>
                </div>
                <form action={deleteSticker}>
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" className="linky danger">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
