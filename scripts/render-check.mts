/**
 * A real render, through a real browser.
 *
 * Three things are asserted, and each one is a bug that a typecheck cannot see:
 *
 * 1. **It is actually a PNG**, of the size asked for. `page.screenshot` returning something is
 *    not the same as an image WhatsApp will display, so the header and the dimensions are read
 *    out of the bytes.
 * 2. **A table renders as a table.** This is the reason the feature does not use satori:
 *    `next/og` is already in the tree and costs nothing, and it renders
 *    `<table><tr><td>Ana</td><td>3</td></tr>…` as the string `Ana3Beto1` on one line — no error,
 *    just wrong. A one-line render is exactly what regressing to a CSS subset would look like,
 *    so the height is compared against the same rows laid out as blocks.
 * 3. **Nothing is fetched.** The HTML is model-authored and shaped by whatever somebody typed
 *    into a group chat, so a browser that will load a URL is a browser that can be aimed at
 *    `169.254.169.254`. Asserted on the reported list rather than on the picture: an `<img>`
 *    with width and height attributes reserves its box whether or not the bytes ever arrive, so
 *    a height comparison passes while the request goes out regardless.
 *
 * Needs a Chromium. In Docker that is /usr/bin/chromium; anywhere else, point CHROMIUM_PATH at
 * one — a local Chrome will do.
 *
 *   npm run render-check
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../lib/render-html.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

/** Width and height live in the IHDR chunk, big-endian, right after the 8-byte signature. */
const readPng = (png: Buffer) => {
  const signature = png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  return {
    signature,
    width: signature ? png.readUInt32BE(16) : 0,
    height: signature ? png.readUInt32BE(20) : 0,
  };
};

if (!process.env.CHROMIUM_PATH && !existsSync("/usr/bin/chromium")) {
  console.log(
    "\nNo Chromium found. Set CHROMIUM_PATH to one — on Windows that is usually\n" +
      '  "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"\n',
  );
  process.exit(1);
}

console.log("\na picture comes out:");
const card = await render(
  `<div style="display:flex;flex-direction:column;gap:8px;padding:20px;border:2px solid #FFC107;border-radius:14px;background:#0d0d0d;color:#fff;width:360px">
     <strong style="font-size:20px">Deploy Friday</strong>
     <span>Ana, Beto and Cris said yes 👍</span>
   </div>`,
  600,
);
const meta = readPng(card.png);
check("it is a PNG", meta.signature);
check("at the width asked for", card.width === 600, `— ${card.width}`);
// deviceScaleFactor is 2, so the pixels are twice the CSS size — that is what keeps it sharp.
check("rendered at 2x", meta.width === 1200, `— ${meta.width}px for 600`);
check("with a height that came from the content", meta.height === card.height * 2);
check("and it is not blank-tall", card.height > 40 && card.height < 400, `— ${card.height}`);

/*
 * The satori regression, stated as an assertion.
 *
 * Three rows laid out as a table must be about as tall as three rows laid out as blocks. Collapse
 * them onto one line — which is what a renderer without table layout does — and the table comes
 * out a third of the height.
 */
console.log("\na table is laid out as a table:");
const rows = ["Ana", "Beto", "Cris"];
const table = await render(
  `<table border="1"><tbody>${rows
    .map((n, i) => `<tr><td>${n}</td><td>${i + 1}</td></tr>`)
    .join("")}</tbody></table>`,
  400,
);
const blocks = await render(
  `<div>${rows.map((n, i) => `<div style="padding:6px 12px">${n} ${i + 1}</div>`).join("")}</div>`,
  400,
);
check(
  "three rows are three rows tall",
  table.height > blocks.height * 0.7,
  `— table ${table.height}px against ${blocks.height}px stacked`,
);

console.log("\nnothing is fetched:");
const METADATA = "http://169.254.169.254/latest/meta-data/";
const withRemote = await render(
  `<style>body{background:url(https://fonts.example/f.css)}</style>
   <img src="${METADATA}" alt="">
   <p>text</p>`,
  400,
);
check("the link-local address is refused", withRemote.blocked.includes(METADATA));
check(
  "and so is a stylesheet from anywhere else",
  withRemote.blocked.some((u) => u.includes("fonts.example")),
);
check(
  "which is reported rather than swallowed",
  withRemote.blocked.length === 2,
  `— ${withRemote.blocked.join(", ")}`,
);

const inline =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const withInline = await render(`<img src="${inline}" width="200" height="120" alt="">`, 400);
check("an inlined one still loads", withInline.blocked.length === 0, `— ${withInline.blocked.join(", ")}`);
check("and takes up its space", withInline.height > 120, `— ${withInline.height}px`);

console.log("\nbounds:");
const wide = await render("<div>x</div>", 9000);
check("an absurd width is clamped", wide.width === 1200, `— ${wide.width}`);
const narrow = await render("<div>x</div>", 10);
check("and an absurd narrow one too", narrow.width === 320, `— ${narrow.width}`);
const long = await render(`<div>${"<p>line</p>".repeat(600)}</div>`, 400);
check("a runaway page is capped", long.height === 4000, `— ${long.height}`);

const out = join(tmpdir(), "render-check.png");
writeFileSync(out, card.png);
console.log(`\nwrote ${out} — worth a look`);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
