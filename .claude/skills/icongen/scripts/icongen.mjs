#!/usr/bin/env node
/**
 * icongen.mjs — generate a favicon / app-icon set as SVG, ICO and PNG.
 *
 * Dependency-free at rest. Rasterization is delegated on demand to
 * `npx --yes sharp-cli`; the ICO container is written by this file.
 *
 *   node scripts/icongen.mjs --text y --out ./public
 *   node scripts/icongen.mjs --svg logo.svg --out ./public --name "My App"
 *   node scripts/icongen.mjs --glyph "M4 6h16M4 12h10" --out ./public
 *   node scripts/icongen.mjs --config ./public/icon.config.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SIZE = 32; // icon-space units; every geometry flag is in these units
const CMD = /[MLHVCQZmlhvcqz]/;
const TOKENS = /[MLHVCQZmlhvcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g;

// ---------------------------------------------------------------- defaults

const DEFAULTS = {
  text: null,
  svg: null,
  glyph: null,
  glyphBox: 24, // the --glyph author grid, per references/drawing-rules.md
  out: "./public",
  name: null,
  shortName: null,
  face: "serif-italic",
  bg: "#111111",
  fg: "#fafafa",
  bgDark: null, // defaults to fg — a straight inversion
  fgDark: null, // defaults to bg
  radius: 6,
  scale: 0.58, // text mode: em height as a fraction of the icon
  padding: 5, // artwork mode: inset around the source bounds
  stroke: null, // --glyph mode: stroke-width override on the author grid
  recolor: true,
  darkRasters: false,
  svgOnly: false,
  themeColor: null, // defaults to bg
};

const USAGE = `
icongen — SVG + ICO + PNG icon set generator

Input (exactly one):
  --text <chars>       1-2 characters, rendered from baked IBM Plex outlines
  --svg <file>         an existing single-colour SVG (Lucide, Simple Icons...)
  --glyph <path-d>     raw SVG path data drawn on a 24x24 grid

Output:
  --out <dir>          output directory                      (default ./public)
  --name <string>      application name for site.webmanifest
  --short-name <str>   short name for site.webmanifest
  --dark-rasters       also emit dark PNG variants           (default off)
  --svg-only           skip rasterization; emit SVG only, no npx needed

Style:
  --face <id>          serif-italic | sans-medium | mono  (default serif-italic)
  --bg <colour>        container fill                        (default #111111)
  --fg <colour>        glyph fill                            (default #fafafa)
  --bg-dark <colour>   dark-variant container       (default: inverted, = --fg)
  --fg-dark <colour>   dark-variant glyph           (default: inverted, = --bg)
  --radius <n>         corner radius in 32-unit space        (default 6)
  --scale <0..1>       text mode: em height / icon size      (default 0.58)
  --padding <n>        artwork mode: inset in 32-unit space  (default 5)
  --stroke <n>         --glyph mode: stroke-width on the author grid
  --glyph-box <n>      --glyph mode: author grid size        (default 24)
  --no-recolor         keep the source SVG's own colours
  --theme-color <col>  manifest/meta theme colour            (default = --bg)

Other:
  --config <file>      load a previously emitted icon.config.json
  --help               this message

Flags always win over --config. The resolved configuration is written to
<out>/icon.config.json so the exact same set can be regenerated later.
`;

// -------------------------------------------------------------------- argv

function parseArgs(argv) {
  const flags = {};
  const BOOLEAN = new Set(["help", "no-recolor", "dark-rasters", "svg-only"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (BOOLEAN.has(key)) {
      flags[key] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail(`--${key} needs a value`);
    }
    flags[key] = value;
  }
  return flags;
}

function fail(message) {
  console.error(`icongen: ${message}\n`);
  process.exit(1);
}

function num(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${label} must be a number, got ${JSON.stringify(value)}`);
  return n;
}

function resolveConfig(flags) {
  let cfg = { ...DEFAULTS };

  if (flags.config) {
    const file = path.resolve(flags.config);
    if (!fs.existsSync(file)) fail(`--config file not found: ${file}`);
    let loaded;
    try {
      loaded = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      fail(`--config file is not valid JSON: ${err.message}`);
    }
    // A config emitted next to the icons should keep resolving --svg and --out
    // relative to itself, not to wherever the command happens to be run from.
    const base = path.dirname(file);
    if (loaded.svg) loaded.svg = path.resolve(base, loaded.svg);
    if (loaded.out) loaded.out = path.resolve(base, loaded.out);
    cfg = { ...cfg, ...loaded };
  }

  const strings = {
    text: "text",
    svg: "svg",
    glyph: "glyph",
    out: "out",
    name: "name",
    "short-name": "shortName",
    face: "face",
    bg: "bg",
    fg: "fg",
    "bg-dark": "bgDark",
    "fg-dark": "fgDark",
    "theme-color": "themeColor",
  };
  for (const [flag, key] of Object.entries(strings)) {
    if (flags[flag] !== undefined) cfg[key] = flags[flag];
  }
  const numbers = {
    radius: "radius",
    scale: "scale",
    padding: "padding",
    stroke: "stroke",
    "glyph-box": "glyphBox",
  };
  for (const [flag, key] of Object.entries(numbers)) {
    if (flags[flag] !== undefined) cfg[key] = num(flags[flag], `--${flag}`);
  }
  if (flags["no-recolor"]) cfg.recolor = false;
  if (flags["dark-rasters"]) cfg.darkRasters = true;
  if (flags["svg-only"]) cfg.svgOnly = true;

  const inputs = ["text", "svg", "glyph"].filter((key) => cfg[key]);
  if (inputs.length === 0) {
    fail("no input — pass one of --text, --svg or --glyph (--help for usage)");
  }
  if (inputs.length > 1) {
    fail(`pass exactly one input, got ${inputs.map((i) => "--" + i).join(" and ")}`);
  }

  cfg.bgDark = cfg.bgDark ?? cfg.fg;
  cfg.fgDark = cfg.fgDark ?? cfg.bg;
  cfg.themeColor = cfg.themeColor ?? cfg.bg;
  cfg.name = cfg.name ?? (cfg.text ? String(cfg.text).toUpperCase() : "App");
  cfg.shortName = cfg.shortName ?? cfg.name;

  if (cfg.radius < 0 || cfg.radius > SIZE / 2) fail(`--radius must be 0..${SIZE / 2}`);
  if (cfg.scale <= 0 || cfg.scale > 1) fail("--scale must be greater than 0 and at most 1");
  if (cfg.padding < 0 || cfg.padding >= SIZE / 2) fail(`--padding must be 0..${SIZE / 2 - 1}`);
  if (cfg.glyphBox <= 0) fail("--glyph-box must be greater than 0");

  return cfg;
}

// -------------------------------------------------- path data: bbox, transform

function bezier(coords, t) {
  const u = 1 - t;
  if (coords.length === 4) {
    return (
      u * u * u * coords[0] +
      3 * u * u * t * coords[1] +
      3 * u * t * t * coords[2] +
      t * t * t * coords[3]
    );
  }
  return u * u * coords[0] + 2 * u * t * coords[1] + t * t * coords[2];
}

/**
 * Tight bounding box of absolute path data (M/L/H/V/C/Q/Z, as produced by
 * opentype.js). Curves are flattened rather than bounded by their control
 * hull, so optical centring is not thrown off by distant control points.
 */
function pathBounds(d) {
  const tokens = d.match(TOKENS) || [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let cmd = null;
  let i = 0;

  const hit = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const take = () => Number(tokens[i++]);
  const curve = (points) => {
    const STEPS = 24;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    for (let step = 0; step <= STEPS; step++) {
      const t = step / STEPS;
      hit(bezier(xs, t), bezier(ys, t));
    }
  };

  while (i < tokens.length) {
    if (CMD.test(tokens[i])) {
      cmd = tokens[i];
      i++;
      if (cmd === "Z" || cmd === "z") {
        cx = startX;
        cy = startY;
        cmd = null;
      }
      continue;
    }
    switch (cmd) {
      case "M": {
        cx = take();
        cy = take();
        startX = cx;
        startY = cy;
        hit(cx, cy);
        cmd = "L"; // repeated pairs after a moveto are implicit linetos
        break;
      }
      case "L": {
        cx = take();
        cy = take();
        hit(cx, cy);
        break;
      }
      case "H": {
        cx = take();
        hit(cx, cy);
        break;
      }
      case "V": {
        cy = take();
        hit(cx, cy);
        break;
      }
      case "C": {
        const x1 = take();
        const y1 = take();
        const x2 = take();
        const y2 = take();
        const x = take();
        const y = take();
        curve([[cx, cy], [x1, y1], [x2, y2], [x, y]]);
        cx = x;
        cy = y;
        break;
      }
      case "Q": {
        const x1 = take();
        const y1 = take();
        const x = take();
        const y = take();
        curve([[cx, cy], [x1, y1], [x, y]]);
        cx = x;
        cy = y;
        break;
      }
      default:
        i++; // stray number with no command in scope
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function round(n) {
  return Math.abs(n) < 1e-6 ? 0 : Number(n.toFixed(3));
}

/**
 * Scale then translate path data by rewriting its coordinates.
 *
 * Only valid for absolute commands: a relative delta must be scaled but NOT
 * translated, so feeding relative data through here silently produces
 * nonsense. Everything this is used on comes from opentype.js, which emits
 * M/L/C/Q/Z absolute only — the guard is here so that stays true. Artwork
 * paths, which are hand-authored and full of relative commands, are placed
 * with a <g transform> instead.
 */
function transformPath(d, scale, dx, dy) {
  const tokens = d.match(TOKENS) || [];
  for (const token of tokens) {
    if (CMD.test(token) && !/[MLHVCQZz]/.test(token)) {
      throw new Error(`transformPath: unsupported path command ${JSON.stringify(token)}`);
    }
  }
  const out = [];
  let cmd = null;
  let axis = 0;
  for (const token of tokens) {
    if (CMD.test(token)) {
      cmd = token;
      axis = cmd === "V" ? 1 : 0;
      out.push(cmd);
      continue;
    }
    const n = Number(token);
    if (cmd === "H") {
      out.push(round(n * scale + dx));
    } else if (cmd === "V") {
      out.push(round(n * scale + dy));
    } else {
      out.push(round(n * scale + (axis === 0 ? dx : dy)));
      axis = 1 - axis;
    }
  }
  return out
    .join(" ")
    .replace(/([MLHVCQZmlhvcqz]) /g, "$1")
    .replace(/ ([MLHVCQZmlhvcqz])/g, "$1")
    .trim();
}

// ------------------------------------------------------------ glyph sources

let glyphData = null;
function glyphs() {
  if (glyphData) return glyphData;
  const file = path.join(ROOT, "assets", "glyphs.json");
  if (!fs.existsSync(file)) {
    fail("assets/glyphs.json is missing — re-run scripts/bake-glyphs.mjs (see its header)");
  }
  glyphData = JSON.parse(fs.readFileSync(file, "utf8"));
  return glyphData;
}

/** --text mode: compose baked outlines into one centred path. */
function buildTextPath(cfg) {
  const data = glyphs();
  const face = data.faces[cfg.face];
  if (!face) {
    fail(
      `unknown --face ${JSON.stringify(cfg.face)} — available: ${Object.keys(data.faces).join(", ")}`
    );
  }

  const chars = [...String(cfg.text)];
  const missing = chars.filter((ch) => !face.glyphs[ch]);
  if (missing.length) {
    fail(
      `no baked outline for ${missing.map((c) => JSON.stringify(c)).join(", ")} in face ${cfg.face}.\n` +
        `  The baked charset is frozen at: ${data.charset}\n` +
        "  To add characters, extend CHARSET in scripts/bake-glyphs.mjs and re-run it."
    );
  }
  if (chars.length > 3) {
    console.warn(
      `icongen: ${chars.length} characters is a lot for a ${SIZE}px icon — 1 or 2 reads best.`
    );
  }

  // Lay the glyphs out in font units first, kerning included.
  const parts = [];
  let cursor = 0;
  chars.forEach((ch, index) => {
    const glyph = face.glyphs[ch];
    if (glyph.d) parts.push(transformPath(glyph.d, 1, cursor, 0));
    let advance = glyph.a;
    const next = chars[index + 1];
    if (next) advance += face.kern[ch + next] || 0;
    cursor += advance;
  });
  const composed = parts.join("");
  if (!composed) fail("the requested text produced no outlines (whitespace only?)");

  // Size by em, not by bounding box: a lowercase 'x' and a capital 'X' have to
  // come out at the same stroke weight, which fitting a tight bbox destroys.
  const unit = (SIZE * cfg.scale) / face.unitsPerEm;
  const scaled = transformPath(composed, unit, 0, 0);

  // Centre optically, on the tight bbox of the marks that actually get drawn.
  const bounds = pathBounds(scaled);
  if (!bounds) fail("could not measure the composed outlines");
  const dx = (SIZE - bounds.w) / 2 - bounds.x;
  const dy = (SIZE - bounds.h) / 2 - bounds.y;
  return { d: transformPath(scaled, 1, dx, dy) };
}

/**
 * --glyph mode: raw path data authored on the drawing-rules grid.
 *
 * Placed with a <g transform> rather than by rewriting coordinates, so that
 * relative commands, arcs and shorthand curves all survive intact. The
 * transform scales stroke-width along with the geometry, which is what keeps
 * a 2-unit stroke on the author grid looking like a 2-unit stroke.
 */
function buildGlyphArtwork(cfg) {
  const inner = SIZE - 2 * cfg.padding;
  const scale = inner / cfg.glyphBox;
  const d = esc(String(cfg.glyph).trim());
  if (!d) fail("--glyph is empty");
  const strokeWidth = cfg.stroke ?? 2;
  return {
    markup: (fg) =>
      `<g transform="translate(${round(cfg.padding)} ${round(cfg.padding)}) scale(${round(scale)})"` +
      ` fill="none" stroke="${esc(fg)}" stroke-width="${round(strokeWidth)}"` +
      ' stroke-linecap="round" stroke-linejoin="round">' +
      `<path d="${d}"/></g>`,
  };
}

/** --svg mode: inline an existing single-colour SVG. */
function buildSvgArtwork(cfg) {
  const file = path.resolve(cfg.svg);
  if (!fs.existsSync(file)) fail(`--svg file not found: ${file}`);
  const raw = fs.readFileSync(file, "utf8");

  const open = raw.match(/<svg\b[^>]*>/i);
  if (!open) fail(`--svg file has no <svg> element: ${file}`);
  const attrs = open[0];

  const viewBox = attrs.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  let minX = 0;
  let minY = 0;
  let boxW;
  let boxH;
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      fail(`--svg has an unreadable viewBox: ${viewBox[1]}`);
    }
    [minX, minY, boxW, boxH] = parts;
  } else {
    const w = attrs.match(/\bwidth\s*=\s*["']([\d.]+)/i);
    const h = attrs.match(/\bheight\s*=\s*["']([\d.]+)/i);
    if (!w || !h) fail(`--svg needs a viewBox, or a numeric width and height: ${file}`);
    boxW = Number(w[1]);
    boxH = Number(h[1]);
  }
  if (!(boxW > 0 && boxH > 0)) fail("--svg has zero-sized bounds");

  const body = raw
    .slice(open.index + attrs.length)
    .replace(/<\/svg\s*>[\s\S]*$/i, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(title|desc|metadata)\b[\s\S]*?<\/\1\s*>/gi, "")
    .trim();
  if (!body) fail(`--svg file has no drawable content: ${file}`);

  const inner = SIZE - 2 * cfg.padding;
  const scale = Math.min(inner / boxW, inner / boxH);
  const dx = cfg.padding + (inner - boxW * scale) / 2 - minX * scale;
  const dy = cfg.padding + (inner - boxH * scale) / 2 - minY * scale;

  return {
    markup: (fg) => {
      const content = cfg.recolor ? recolor(body, fg) : body;
      // fill on the wrapper covers elements that carry no fill of their own
      // (Simple Icons). Deliberately no stroke on the wrapper: that would put
      // a 1px outline around every one of those same elements.
      return (
        `<g transform="translate(${round(dx)} ${round(dy)}) scale(${round(scale)})"` +
        (cfg.recolor ? ` fill="${esc(fg)}"` : "") +
        `>${content}</g>`
      );
    },
  };
}

/** Retarget an icon SVG's colours onto `fg`, leaving `none` alone. */
function recolor(markup, fg) {
  return markup
    .replace(/currentColor/g, fg)
    .replace(/\b(fill|stroke)\s*=\s*(["'])(.*?)\2/gi, (match, prop, quote, value) =>
      value.trim().toLowerCase() === "none" ? match : `${prop}="${fg}"`
    )
    .replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
      const next = value.replace(/\b(fill|stroke)\s*:\s*([^;]+)/gi, (decl, prop, colour) =>
        colour.trim().toLowerCase() === "none" ? decl : `${prop}:${fg}`
      );
      return `style="${next}"`;
    });
}

function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// ----------------------------------------------------------------- assembly

function renderSvg(artwork, { bg, fg, radius, px }) {
  const side = px ?? SIZE;
  const rect =
    radius > 0
      ? `<rect width="${SIZE}" height="${SIZE}" rx="${round(radius)}" fill="${esc(bg)}"/>`
      : `<rect width="${SIZE}" height="${SIZE}" fill="${esc(bg)}"/>`;
  const marks = artwork.d ? `<path d="${artwork.d}" fill="${esc(fg)}"/>` : artwork.markup(fg);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"` +
    ` width="${side}" height="${side}">${rect}${marks}</svg>\n`
  );
}

// ------------------------------------------------------------- ICO encoding

/**
 * Pack PNG buffers into an ICO: a 6-byte ICONDIR, one 16-byte ICONDIRENTRY
 * per image, then the PNG payloads. PNG-inside-ICO is valid and universally
 * supported since Windows Vista.
 */
function buildIco(images) {
  if (!images.length) throw new Error("buildIco: no images");

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((image, index) => {
    if (image.size > 256) throw new Error(`buildIco: ${image.size}px exceeds the 256px ICO limit`);
    const at = index * 16;
    const dim = image.size === 256 ? 0 : image.size; // 0 encodes 256
    directory.writeUInt8(dim, at + 0);
    directory.writeUInt8(dim, at + 1);
    directory.writeUInt8(0, at + 2); // palette entries, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

// ---------------------------------------------------------- rasterization

function rasterize(jobs, tmpDir) {
  if (!jobs.length) return;
  const inDir = path.join(tmpDir, "in");
  const outDir = path.join(tmpDir, "out");
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const job of jobs) {
    fs.writeFileSync(path.join(inDir, `${job.key}.svg`), job.svg);
  }

  // One npx call renders every size: sharp honours each SVG's intrinsic
  // width/height, so no resampling is involved and every size is a true
  // vector render rather than a downscale of a bigger raster.
  const args = [
    "--yes",
    "sharp-cli",
    "-i",
    ...jobs.map((job) => path.join(inDir, `${job.key}.svg`)),
    "-o",
    outDir,
    "-f",
    "png",
  ];

  // .cmd shims need a shell on Windows, and a shell means quoting is ours.
  const useShell = process.platform === "win32";
  const result = spawnSync(
    "npx",
    useShell ? args.map((arg) => (/[\s&|<>^]/.test(arg) ? `"${arg}"` : arg)) : args,
    { encoding: "utf8", shell: useShell }
  );

  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    fail(
      "rasterization failed.\n" +
        "  icongen shells out to `npx --yes sharp-cli` for PNG rendering, which needs\n" +
        "  npm on PATH and network access the first time (it is cached afterwards).\n" +
        "  Use --svg-only to generate just the SVGs without rasterizing.\n" +
        (detail ? `\n  ${detail.split("\n").join("\n  ")}\n` : "")
    );
  }

  for (const job of jobs) {
    const produced = path.join(outDir, `${job.key}.png`);
    if (!fs.existsSync(produced)) fail(`sharp-cli produced no output for ${job.key}`);
    job.data = fs.readFileSync(produced);
    const width = job.data.readUInt32BE(16);
    if (width !== job.size) {
      fail(`expected a ${job.size}px render for ${job.key}, got ${width}px`);
    }
  }
}

// ------------------------------------------------------------ side outputs

function buildManifest(cfg) {
  return (
    JSON.stringify(
      {
        name: cfg.name,
        short_name: cfg.shortName,
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
        theme_color: cfg.themeColor,
        background_color: cfg.themeColor,
        display: "standalone",
      },
      null,
      2
    ) + "\n"
  );
}

function headSnippet(cfg) {
  return `<link rel="icon" href="/favicon.ico" sizes="32x32" />
<link id="favicon" rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/site.webmanifest" />
<meta name="theme-color" content="${cfg.themeColor}" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="${cfg.bgDark}" media="(prefers-color-scheme: dark)" />

<!-- optional: follow the reader's theme, using the dark half of the pair -->
<script>
  (function () {
    try {
      var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      var el = document.getElementById("favicon");
      if (el && dark) el.href = "/favicon-dark.svg";
    } catch (e) {}
  })();
</script>`;
}

// -------------------------------------------------------------------- main

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE.trim());
    return;
  }

  const cfg = resolveConfig(flags);
  const outDir = path.resolve(cfg.out);
  fs.mkdirSync(outDir, { recursive: true });

  const artwork = cfg.text
    ? buildTextPath(cfg)
    : cfg.glyph
      ? buildGlyphArtwork(cfg)
      : buildSvgArtwork(cfg);

  const light = { bg: cfg.bg, fg: cfg.fg };
  const dark = { bg: cfg.bgDark, fg: cfg.fgDark };
  const written = [];
  const write = (file, data) => {
    fs.writeFileSync(path.join(outDir, file), data);
    written.push(file);
  };

  write("favicon.svg", renderSvg(artwork, { ...light, radius: cfg.radius }));
  write("favicon-dark.svg", renderSvg(artwork, { ...dark, radius: cfg.radius }));

  if (!cfg.svgOnly) {
    const jobs = [];
    const add = (key, size, theme, radius) =>
      jobs.push({ key, size, svg: renderSvg(artwork, { ...theme, radius, px: size }) });

    for (const size of [16, 32, 48]) add(`ico-${size}`, size, light, cfg.radius);
    for (const size of [16, 32, 48]) add(`ico-dark-${size}`, size, dark, cfg.radius);
    // apple-touch-icon is deliberately square: iOS applies its own mask, and a
    // pre-rounded source ends up clipped twice.
    add("apple-touch-icon", 180, light, 0);
    add("icon-192", 192, light, cfg.radius);
    add("icon-512", 512, light, cfg.radius);
    if (cfg.darkRasters) {
      add("apple-touch-icon-dark", 180, dark, 0);
      add("icon-192-dark", 192, dark, cfg.radius);
      add("icon-512-dark", 512, dark, cfg.radius);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "icongen-"));
    try {
      rasterize(jobs, tmpDir);
      const byKey = Object.fromEntries(jobs.map((job) => [job.key, job]));

      write("favicon.ico", buildIco([16, 32, 48].map((s) => byKey[`ico-${s}`])));
      write("favicon-dark.ico", buildIco([16, 32, 48].map((s) => byKey[`ico-dark-${s}`])));

      const pngs = ["apple-touch-icon", "icon-192", "icon-512"];
      if (cfg.darkRasters) {
        pngs.push("apple-touch-icon-dark", "icon-192-dark", "icon-512-dark");
      }
      for (const key of pngs) write(`${key}.png`, byKey[key].data);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    write("site.webmanifest", buildManifest(cfg));
  }

  report(cfg, outDir, written);
}

function report(cfg, outDir, written) {
  // Persist the resolved config so this exact set can be rebuilt later. Paths
  // are stored relative to the config's own location and no timestamp is
  // recorded, so re-running produces a byte-identical file.
  const record = { ...cfg, out: "." };
  if (record.svg) {
    record.svg = path.relative(outDir, path.resolve(record.svg)).split(path.sep).join("/");
  }
  fs.writeFileSync(path.join(outDir, "icon.config.json"), JSON.stringify(record, null, 2) + "\n");
  written.push("icon.config.json");

  console.log(`icongen → ${outDir}`);
  for (const file of written) {
    const bytes = fs.statSync(path.join(outDir, file)).size;
    console.log(`  ${file.padEnd(24)} ${String(bytes).padStart(7)} B`);
  }
  console.log("\nPaste into <head>:\n");
  console.log(headSnippet(cfg));
  const configPath = path.join(cfg.out, "icon.config.json").split(path.sep).join("/");
  console.log("\nRebuild this exact set with:");
  console.log(`  node scripts/icongen.mjs --config ${configPath}`);
}

main();
