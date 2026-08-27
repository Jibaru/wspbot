---
name: icongen
description: Generate a complete favicon and app-icon set — favicon.svg, favicon.ico, apple-touch-icon, PWA PNGs and site.webmanifest — from a letter, an existing SVG, or a described icon, with matching light and dark variants. Use when the user asks to "make a favicon", "generate an icon", "create an app icon", "I need a .ico", "convert SVG to ICO", "make a monogram", "add icons to my site", or wants a browser tab icon for a website or web app.
metadata:
  author: Jibaru
  version: 1.0.0
---

# icongen

Generate a favicon / app-icon set. Vector first, then a real multi-size `.ico`
and the PNGs a modern site needs.

## Choosing the input mode

Exactly one input. Pick it from what the user has:

| The user gives you… | Mode | Example |
| --- | --- | --- |
| a name, initials, a letter | `--text` | "favicon for Acme" → `--text A` |
| an existing SVG logo or icon file | `--svg` | "use my logo.svg" |
| a description of a picture | `--glyph` | "a terminal icon" |

**`--glyph` is the mode where you do the drawing.** There is no image model
involved: read `references/drawing-rules.md`, hand-author the path data on the
24 × 24 grid it specifies, and pass it in. Those rules are what keep separately
generated icons looking like one set — read them before drawing, every time.

If the request is pictorial beyond simple geometry ("a photorealistic owl"),
say so plainly and offer a monogram instead. Do not produce a bad drawing.

## Running it

```bash
node scripts/icongen.mjs --text y --out ./public --name "My Site"
node scripts/icongen.mjs --svg ./logo.svg --out ./public --name "My Site"
node scripts/icongen.mjs --glyph "M4 17l6-6-6-6M12 19h8" --out ./public
```

`--help` lists every flag. The ones that matter most:

- `--out <dir>` — where the files land (default `./public`)
- `--name <string>` — application name for `site.webmanifest`
- `--face serif-italic | sans-medium | mono` — the monogram typeface
- `--bg` / `--fg` — container and glyph colours
- `--radius <n>` — corner radius, in the 32-unit icon space (default `6`)
- `--scale <0..1>` — `--text` only: how much of the icon the letter fills
- `--padding <n>` — `--svg` / `--glyph` only: inset around the artwork
- `--svg-only` — vector output only; needs no network, see below

Defaults produce a near-black `#111111` tile with a `#fafafa` mark and a
6-unit radius. Override the colours for any other brand; there is no preset
file to edit.

## What it writes

| File | Notes |
| --- | --- |
| `favicon.svg` / `favicon-dark.svg` | the light/dark pair |
| `favicon.ico` / `favicon-dark.ico` | 16, 32 and 48 px, PNG-compressed |
| `apple-touch-icon.png` | 180 px, **deliberately square** — iOS applies its own mask, and a pre-rounded source gets clipped twice |
| `icon-192.png`, `icon-512.png` | PWA / Android |
| `site.webmanifest` | wired to the two PNGs above |
| `icon.config.json` | the resolved settings |

The `<head>` snippet is printed to stdout when the command finishes — hand it
to the user, or paste it in yourself if you can see their template.

**Dark PNGs are not written by default.** Nothing consumes them: a manifest
icon and an `apple-touch-icon` are single-valued, so only the SVG and ICO can
actually be swapped at runtime. Pass `--dark-rasters` if the user explicitly
wants the full dark set anyway.

## Regenerating

`icon.config.json` is written next to the icons and records every resolved
setting. To rebuild the same set later — a new size, a colour tweak — load it
instead of reconstructing flags:

```bash
node scripts/icongen.mjs --config ./public/icon.config.json
node scripts/icongen.mjs --config ./public/icon.config.json --bg "#0a0a0a"
```

Flags always beat the file. Output is deterministic and carries no timestamp,
so an unchanged rerun produces byte-identical files and a clean `git diff`.

## Dependencies

The skill is a folder of text files — no `package.json`, no `node_modules`.

PNG rasterization shells out to `npx --yes sharp-cli`, which needs npm on
`PATH` and network access **the first time only** (npm caches it afterwards).
The `.ico` container is written by `scripts/icongen.mjs` itself.

If there is no network and none is cached, `--svg-only` still produces
`favicon.svg`, `favicon-dark.svg` and `icon.config.json`.

## Notes and limits

- **Monogram letterforms are baked, not looked up.** `assets/glyphs.json`
  holds real IBM Plex outlines as path data, so output carries no font
  dependency and the `.svg` and `.ico` can never disagree about the shape.
- **The baked charset is frozen**: `A-Z a-z 0-9 & @ # + - . ! ? * < > /`.
  Anything else fails with a clear error. To extend it, edit `CHARSET` in
  `scripts/bake-glyphs.mjs` and re-run that script — it is a development tool
  and needs its own dev dependencies; see the header comment in that file.
- One or two characters read best. Three is a warning; more is unreadable at
  16 px.
- `--svg` recolours the source onto `--fg`, leaving `fill="none"` alone. It
  handles ordinary single-colour icon SVGs (Lucide, Simple Icons). Multicolour
  or gradient artwork should be passed with `--no-recolor`, and will then
  ignore the dark variant's palette.
- The dark variant defaults to a straight inversion of `--bg` / `--fg`.
  Override with `--bg-dark` / `--fg-dark`.
