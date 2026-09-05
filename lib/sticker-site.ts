import "server-only";
import * as stickers from "./stickers";
import type { FileToWrite } from "./github";

/**
 * The sticker library, as a website.
 *
 * Kept apart from `lib/github.ts` because it is a page rather than an API client: one file knows
 * how to commit files, this one knows what the files should say. Mixing them would put a design
 * decision inside the thing that talks to GitHub, and the next export — a memory dump, a digest
 * archive — would have nowhere to live but there too.
 *
 * The stickers are committed as files rather than linked to wapi. A wapi URL dies with the
 * session that uploaded it, so a page built from those links is a page of broken images by the
 * time somebody changes the bot's number. The bytes are already in Postgres for exactly this
 * reason, so the site carries its own copies and outlives everything here.
 */

/** A filename that survives a label like "gato 😹 / feliz". */
const slug = (label: string, id: string): string => {
  const base = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // The id keeps it unique: two stickers called "cat" are not the same sticker.
  return `${base || "sticker"}-${id}.webp`;
};

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export type Built = {
  files: FileToWrite[];
  /** How many stickers the page shows. */
  count: number;
  /** Held back because the commit would have been too big, or too many files. */
  left: number;
  /** In the library but with no stored picture, so nothing to publish. */
  skipped: number;
};

/**
 * What one commit may carry, and why there is a budget at all.
 *
 * The real library is 313 stickers and 49MB. Publishing all of it would be a 49MB commit built
 * from 313 sequential blob uploads — minutes of API calls for one chat message, and a repository
 * nobody wants to clone. So the newest are taken until either ceiling is reached and the rest are
 * reported, which is a page that exists over a request that times out.
 */
const MAX_STICKERS = 150;
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Room for index.html inside the budget rather than on top of it, so the ceiling means the size
 * of the commit — which is what it is for — and not the size of the pictures in it.
 */
const PAGE_ALLOWANCE = 256 * 1024;

/**
 * Build the whole site: one picture per sticker, plus the page that shows them.
 *
 * Crafter Station's colours, because it is the bot's own library and it will be linked from
 * chats where the bot has a face. Everything inline — no fonts, no stylesheet, no script — so
 * the page works the moment Pages serves it, from a subdirectory, offline, and in a webview.
 */
export const build = async (
  options: { title?: string; limit?: number; budgetBytes?: number } = {},
): Promise<Built> => {
  const limit = Math.min(options.limit ?? MAX_STICKERS, MAX_STICKERS);
  const budget = Math.min(options.budgetBytes ?? MAX_BYTES, MAX_BYTES) - PAGE_ALLOWANCE;

  /*
   * Sizes first, bytes second. Choosing what fits from a list of byte counts costs one small
   * query; choosing it from the pictures themselves means dragging 49MB out of Postgres to use
   * 20MB of it, which is slow enough to be cancelled mid-flight.
   */
  const { stickers: found, skipped } = await stickers.sizes(500);

  const chosen: stickers.StickerSize[] = [];
  let used = 0;
  let left = 0;
  for (const sticker of found) {
    if (chosen.length >= limit || used + sticker.size > budget) {
      left++;
      continue;
    }
    used += sticker.size;
    chosen.push(sticker);
  }

  const bytes = await stickers.bytesFor(chosen.map((s) => s.id));
  const title = options.title ?? "Sticker library";

  const files: FileToWrite[] = [];
  const cards: string[] = [];

  for (const sticker of chosen) {
    const picture = bytes.get(sticker.id);
    // Vanishingly unlikely — deleted between the two queries — and cheaper to skip than to guard.
    if (!picture) continue;

    const name = slug(sticker.label, sticker.id);
    files.push({ path: `stickers/${name}`, content: picture });
    cards.push(
      [
        '    <figure class="s">',
        `      <img src="stickers/${name}" alt="${escape(sticker.description ?? sticker.label)}" loading="lazy" width="160" height="160">`,
        `      <figcaption>${escape(sticker.label)}</figcaption>`,
        "    </figure>",
      ].join("\n"),
    );
  }

  const when = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  files.push({
    path: "index.html",
    content: page(title, cards.join("\n"), cards.length, when),
  });

  return { files, count: cards.length, left, skipped };
};

const page = (title: string, cards: string, count: number, when: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${count} stickers collected in WhatsApp.">
<style>
  :root { color-scheme: dark; --bg: #0d0d0d; --card: #151515; --line: #262626; --text: #f5f5f5; --muted: #a3a3a3; --accent: #ffc107; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 3rem 1.25rem 5rem; background: var(--bg); color: var(--text);
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: clamp(1.8rem, 5vw, 2.8rem); margin: 0 0 .4rem; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  p.lede { color: var(--muted); margin: 0 0 2.5rem; }
  .grid { display: grid; gap: .9rem;
          grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .s { margin: 0; padding: .9rem .6rem .7rem; background: var(--card); border: 1px solid var(--line);
       border-radius: 14px; text-align: center; transition: border-color .18s cubic-bezier(0.16,1,0.3,1),
       transform .18s cubic-bezier(0.16,1,0.3,1); }
  .s:hover { border-color: var(--accent); transform: translateY(-2px); }
  .s img { width: 100%; height: auto; aspect-ratio: 1; object-fit: contain; display: block; }
  .s figcaption { margin-top: .6rem; font-size: .78rem; color: var(--muted); overflow-wrap: anywhere; }
  footer { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line);
           color: var(--muted); font-size: .85rem; }
  footer a { color: var(--accent); }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>${escape(title)}<span>.</span></h1>
  <p class="lede">${count} sticker${count === 1 ? "" : "s"} collected in WhatsApp · ${when}</p>
  <div class="grid">
${cards || '    <p class="empty">Nothing here yet.</p>'}
  </div>
  <footer>
    Collected by a WhatsApp bot built with
    <a href="https://github.com/Jibaru/wspbot">wspbot</a>.
  </footer>
</main>
</body>
</html>
`;
