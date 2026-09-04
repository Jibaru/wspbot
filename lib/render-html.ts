import "server-only";
import puppeteer, { type Browser } from "puppeteer-core";
import { config } from "./config";

/**
 * HTML to a picture.
 *
 * The bot writes HTML all the time — a table of who owes what, a summary laid out properly, a
 * card — and WhatsApp cannot show any of it. This renders it and sends the result as an image.
 *
 * **Chromium rather than satori, and the reason is the whole design.** Next already bundles
 * satori through `next/og`, which would have cost nothing to adopt, and it renders a hand-built
 * flex layout beautifully. But it supports a CSS subset with no table layout: asked to render
 * `<table><tr><td>Ana</td><td>3</td></tr>…`, it emits `Ana3Beto1` on one line — no error, just
 * wrong. Since the point here is rendering HTML the model already wrote for a person to read,
 * and a table is the likeliest thing anyone asks for, the subset is the one thing that cannot be
 * accepted. Chromium costs about 180MB in the image and renders what it is given.
 *
 * Two constraints that are not optional:
 *
 * 1. **No network, at all.** The HTML is model-authored and shaped by whatever somebody typed in
 *    a group chat. A browser that will fetch a URL is a browser that can be pointed at
 *    `169.254.169.254`, so every request that is not a `data:` URI is aborted before it leaves.
 *    Same stance as `lib/fetch-media.ts`, enforced a different way.
 * 2. **One render at a time.** Chromium spikes a couple of hundred megabytes, and this box also
 *    runs Postgres and the whole wapi stack. Two concurrent renders is how a WhatsApp bot causes
 *    an out-of-memory kill somewhere else entirely.
 */

/** Where Alpine puts it. The name changed across releases, so both are tried. */
const CANDIDATES = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];

const executablePath = (): string => {
  const configured = config.chromiumPath();
  if (configured) return configured;
  return CANDIDATES[0] as string;
};

/** Generous for a page with no network to wait on, short enough to bound a stuck render. */
const TIMEOUT_MS = 15_000;

/** Wider than a phone screen renders text too small once WhatsApp scales it down. */
const MIN_WIDTH = 320;
const MAX_WIDTH = 1200;

/** A runaway page must not produce a 40MB screenshot nobody can open. */
const MAX_HEIGHT = 4000;

/**
 * Renders are serialised through this rather than run in parallel. A plain promise chain is
 * enough: each caller waits for the previous one, and a failure does not poison the queue.
 */
let queue: Promise<unknown> = Promise.resolve();

const serialise = <T,>(work: () => Promise<T>): Promise<T> => {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
};

/**
 * `blocked` is what the page tried to fetch and did not get. It is reported rather than merely
 * refused, because the failure it prevents is silent: a page whose stylesheet never arrived
 * still renders, just unstyled, and the model has no way to tell that from its own bad markup.
 * Handed back, it can inline the thing and try again.
 */
export type Rendered = { png: Buffer; width: number; height: number; blocked: string[] };

export const render = async (html: string, width = 720): Promise<Rendered> =>
  serialise(async () => {
    const viewportWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(width)));
    let browser: Browser | undefined;

    try {
      browser = await puppeteer.launch({
        executablePath: executablePath(),
        args: [
          // Required in a container: there is no user namespace to sandbox into.
          "--no-sandbox",
          "--disable-setuid-sandbox",
          // /dev/shm is tiny in Docker and Chromium will crash rather than fall back.
          "--disable-dev-shm-usage",
          "--disable-gpu",
          // One process rather than a tree, which is the difference between 200MB and 500MB.
          "--single-process",
          "--no-zygote",
          "--hide-scrollbars",
        ],
        timeout: TIMEOUT_MS,
      });

      const page = await browser.newPage();
      await page.setViewport({ width: viewportWidth, height: 100, deviceScaleFactor: 2 });

      /*
       * Nothing leaves this browser. `data:` is allowed so an inlined image still works, and
       * everything else — including a stylesheet or a font from a CDN — is aborted. The model is
       * told to inline what it needs; this is what makes that instruction enforced rather than
       * hopeful.
       */
      const blocked = new Set<string>();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("data:")) {
          void request.continue();
          return;
        }
        // `about:blank` is the page setContent replaces; it is not the model's doing.
        if (url !== "about:blank" && blocked.size < 10) blocked.add(url);
        void request.abort();
      });

      // `setContent` rather than a navigation, so there is no URL to resolve and nothing to fetch.
      await page.setContent(wrap(html), { waitUntil: "load", timeout: TIMEOUT_MS });

      /*
       * The height comes from the content: a screenshot of a fixed viewport would either crop a
       * long table or pad a short card with empty space, and both look like a bug.
       */
      const height = Math.min(
        MAX_HEIGHT,
        Math.max(
          1,
          await page.evaluate(() => {
            const body = document.body;
            return Math.ceil(body.getBoundingClientRect().height);
          }),
        ),
      );
      await page.setViewport({ width: viewportWidth, height, deviceScaleFactor: 2 });

      const png = Buffer.from(await page.screenshot({ type: "png" }));
      return { png, width: viewportWidth, height, blocked: [...blocked] };
    } finally {
      // Closed even when the render threw, or the process leaks a Chromium per failure.
      await browser?.close().catch(() => undefined);
    }
  });

/**
 * The page around the model's HTML.
 *
 * It supplies the things that are tedious to ask for every time and easy to forget — a readable
 * font stack, sane spacing, a light background so dark text is legible — while leaving the
 * model's own styles to win, since they come after. `width: max-content` on the body is what
 * lets a narrow card stay narrow instead of being stretched to the viewport.
 */
const wrap = (html: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *, *::before, *::after { box-sizing: border-box; }
  html { background: #ffffff; }
  body {
    margin: 0;
    padding: 24px;
    background: #ffffff;
    color: #111111;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
    width: max-content;
    min-width: 100%;
  }
  table { border-collapse: collapse; }
  th, td { padding: 6px 12px; text-align: left; }
  img, svg { max-width: 100%; }
</style></head><body>${html}</body></html>`;
