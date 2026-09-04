import "server-only";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { config } from "./config";
import { assertPublic, isPrivateAddress } from "./fetch-media";

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
 *
 * `capture` is the other half: a picture of a real web page, which is the one thing `render`
 * cannot do by construction. It is a separate function rather than a flag because it has the
 * opposite network stance, and the two must not be one code path with a boolean deciding whether
 * the SSRF guard runs. See the comment above it.
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
const LAUNCH_ARGS = [
  // Required in a container: there is no user namespace to sandbox into.
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // /dev/shm is tiny in Docker and Chromium will crash rather than fall back.
  "--disable-dev-shm-usage",
  "--disable-gpu",
  /*
   * `--single-process` is not here, and that is deliberate. It halves the memory — 200MB against
   * 500 — and it makes a real page load crash: `Session closed` mid-screenshot, every time, on
   * anything that navigates and runs JavaScript. It survives `setContent` with no network, which
   * is exactly why it looked fine until the first real site was captured. Serialising the renders
   * is what keeps the memory bounded instead.
   */
  "--hide-scrollbars",
];

const launch = (): Promise<Browser> =>
  puppeteer.launch({
    executablePath: executablePath(),
    args: LAUNCH_ARGS,
    timeout: TIMEOUT_MS,
  });

export type Rendered = { png: Buffer; width: number; height: number; blocked: string[] };

export const render = async (html: string, width = 720): Promise<Rendered> =>
  serialise(async () => {
    const viewportWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(width)));
    let browser: Browser | undefined;

    try {
      browser = await launch();
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

/**
 * A picture of a real web page.
 *
 * This is the opposite of `render` in the one way that matters: it has to reach the internet.
 * That makes it the SSRF hole `render` was written to not have, so the guard is not dropped —
 * it is the same `assertPublic` that guards media downloads, applied to every URL the browser
 * is about to open, and applied again per subresource because a public page can pull an
 * `<img src="http://169.254.169.254/…">` and Chromium would fetch it happily.
 *
 * DNS is checked twice, deliberately, and the second check is the one that catches an attack:
 *
 * 1. **Before connecting**, the hostname is resolved here and every address it answers with is
 *    rejected if it is private. That stops the obvious `http://10.0.0.1/` and a name that simply
 *    points inside.
 * 2. **After connecting**, the address Chromium actually reached is read back off the response
 *    and checked again. Between the two, a hostname under someone else's control can change
 *    what it resolves to — DNS rebinding — and the first check cannot see it, because Chromium
 *    resolves the name itself, separately, after we looked. The picture is discarded and the
 *    call fails: by then the request has been made, but nothing comes back to the chat.
 *
 * A page also gets no credentials of ours: no cookies, no auth, a fresh browser each time.
 */

/** Long enough for a slow page that renders itself in JavaScript, short enough to bound a turn. */
const PAGE_TIMEOUT_MS = 25_000;

/** A phone-ish viewport reads better in WhatsApp than a desktop one shrunk to fit. */
const PAGE_WIDTH = 1000;
const PAGE_HEIGHT = 1400;

/** Presenting as headless gets a bot page or a block from a good number of sites. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export class CaptureError extends Error {}

export type Captured = { png: Buffer; url: string; title: string; fullPage: boolean };

export const capture = async (raw: string, fullPage = false): Promise<Captured> =>
  serialise(async () => {
    let target: URL;
    try {
      target = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new CaptureError("that is not a URL I can open");
    }
    // Credentials in a URL are a way to make a request carry something it should not.
    target.username = "";
    target.password = "";

    await assertPublic(target).catch((err: unknown) => {
      throw new CaptureError(err instanceof Error ? err.message : String(err));
    });

    let browser: Browser | undefined;
    /** Set when something got through to a private address; the picture is then never returned. */
    let rebound: string | null = null;
    /** The first URL our own guard dropped, so a failure can say that rather than `net::ERR_FAILED`. */
    let firstBlocked: string | null = null;

    try {
      browser = await launch();
      const page = await browser.newPage();
      await page.setViewport({
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        // A whole page at 2x is a picture too large to send; the fold on its own is worth the
        // sharpness. WhatsApp re-encodes either way.
        deviceScaleFactor: fullPage ? 1 : 2,
      });
      await page.setUserAgent(UA);
      await page.setExtraHTTPHeaders({ "accept-language": "es-PE,es;q=0.9,en;q=0.8" });
      /*
       * `navigator.webdriver` is true whenever a browser is driven over CDP, and a good number of
       * sites read it and serve a challenge page instead of themselves. Hiding it is not evasion
       * of a paywall or a login — nothing here signs in anywhere — it is the difference between
       * photographing a site and photographing an interstitial that says "checking your browser".
       */
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      await page.setRequestInterception(true);
      page.on("request", (request) => {
        void (async () => {
          const url = request.url();
          // `data:` and `blob:` never leave the browser, so they need no resolving.
          if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") {
            await request.continue().catch(() => undefined);
            return;
          }
          try {
            await assertPublic(new URL(url));
            await request.continue();
          } catch {
            // Everything else — file:, a private address, an unresolvable name — is dropped.
            if (!firstBlocked) firstBlocked = url;
            await request.abort().catch(() => undefined);
          }
        })();
      });

      /*
       * The rebinding check. `remoteAddress` is the address Chromium actually connected to,
       * which is the only number in this whole flow that cannot be lied about by a name.
       */
      page.on("response", (response) => {
        const ip = response.remoteAddress()?.ip;
        if (ip && isPrivateAddress(ip)) rebound = `${new URL(response.url()).hostname} (${ip})`;
      });

      /*
       * `domcontentloaded` rather than `networkidle`: a page with a chat widget or an analytics
       * heartbeat never goes idle, and waiting for that turns every capture into a timeout. What
       * gives a client-rendered page its chance is `painted` below, not the load event — on a
       * single-page app the document is "loaded" while the body is still an empty <div id=root>.
       */
      await page.goto(target.toString(), {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      await painted(page);
      await settle(page);

      if (rebound) {
        throw new CaptureError(`${rebound} is inside the private network`);
      }

      const png = Buffer.from(
        await page.screenshot({
          type: "png",
          fullPage,
          // A long page would otherwise produce a strip nobody can read on a phone.
          ...(fullPage ? { captureBeyondViewport: true } : {}),
        }),
      );
      const title = await page.title().catch(() => "");
      return { png, url: target.toString(), title, fullPage };
    } catch (err) {
      if (err instanceof CaptureError) throw err;
      const why = err instanceof Error ? err.message : String(err);
      /*
       * A navigation that fails because *we* aborted it reads as `net::ERR_FAILED`, which sends
       * the model hunting for a problem with the site. Name what was actually refused.
       */
      if (firstBlocked && /ERR_FAILED|ERR_ABORTED|ERR_BLOCKED/.test(why)) {
        throw new CaptureError(`refused to open ${firstBlocked} — it is not a reachable public address`);
      }
      throw new CaptureError(
        /timeout/i.test(why) ? "the page took too long to load" : why,
      );
    } finally {
      await browser?.close().catch(() => undefined);
    }
  });

/**
 * Wait for the page to have something on it.
 *
 * A single-page app fires DOMContentLoaded with an empty `<div id="root">`, and screenshotting
 * there produces a blank picture — which looks exactly like a bug in this code rather than a page
 * that had not drawn yet. So the wait is on the content: text on screen, or an image, or a canvas.
 * Bounded, because a page that genuinely has nothing must still come back rather than time out.
 */
const painted = async (page: Page): Promise<void> => {
  await page
    .waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        if ((body.innerText ?? "").trim().length > 40) return true;
        return document.querySelector("img, svg, canvas, video, picture") !== null;
      },
      { timeout: 8_000, polling: 250 },
    )
    .catch(() => undefined);
};

/**
 * Give a client-rendered page a moment, and scroll it so lazy images load.
 *
 * Without the scroll, a modern landing page screenshots as a column of empty boxes: everything
 * below the fold is waiting on an IntersectionObserver that never fires because nothing ever
 * moved. This is the difference between a picture of a site and a picture of its skeleton.
 */
const settle = async (page: Page): Promise<void> => {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = () => {
          y += window.innerHeight;
          window.scrollTo(0, y);
          if (y < Math.min(document.body.scrollHeight, 12_000)) setTimeout(step, 120);
          else {
            window.scrollTo(0, 0);
            setTimeout(resolve, 400);
          }
        };
        step();
      });
    })
    .catch(() => undefined);
  // Fonts settle after the scroll, and a page screenshotted mid-swap looks broken.
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
};
