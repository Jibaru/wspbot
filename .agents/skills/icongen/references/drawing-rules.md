# Drawing rules for `--glyph`

Constraints for hand-authoring a glyph from a description ("make me a wave
icon"). Follow them and separately-generated icons look like one set; ignore
them and they look like ten different hands.

## The grid

Author on a **24 × 24** grid, origin top-left, y pointing down. This is the
Lucide grid, so Lucide paths can be pasted in unchanged.

Keep all marks inside a **20 × 20 live area** — a 2-unit margin on every side.
`icongen` insets the whole grid again by `--padding`, but strokes are centred
on the path, so a mark sitting on the grid edge loses half its width.

## Strokes, not fills

Draw with strokes. `icongen` emits `fill="none"`, `stroke-width="2"`,
`stroke-linecap="round"` and `stroke-linejoin="round"` for you — do not set
them on the path.

- **2 units** is the only stroke weight. Do not mix weights in one icon.
- Nothing thinner than 2: at 16px a 1-unit stroke disappears.
- A closed path still reads as a silhouette when stroked, which is usually
  enough. If a mark genuinely needs to be filled, author it as a real SVG and
  use `--svg` — `--glyph` never fills.

## Geometry

- Snap endpoints to **whole units**. Half-units (`0.5`) are acceptable for
  optical centring; anything finer is noise.
- Prefer whole-unit radii on arcs and corners.
- Keep the count of subpaths low. **Two or three marks maximum** — this is
  rendered at 16 × 16, where a fourth detail becomes a grey smudge.
- Symmetry reads well at small sizes. Asymmetry needs a reason.

## What survives at 16px

Test mentally at 16 × 16, not at the 512 you are imagining:

- Gaps below 2 units close up into a blob.
- Text, faces, and anything representational disappear. Use one strong
  silhouette.
- Diagonals alias badly; horizontals and verticals stay crisp.

## Path data

Any valid SVG path data works — absolute or relative, arcs and shorthand
curves included. It is placed with a `<g transform>` and passed through
verbatim, so nothing gets rewritten.

Quote it as a single shell argument, and avoid `"` inside it.

## Worked examples

A terminal prompt — two marks, all whole units:

```
--glyph "M4 17l6-6-6-6M12 19h8"
```

A wave — one mark, spanning x 4→19 so it stays inside the live area:

```
--glyph "M4 12c2.5-3.5 5-3.5 7.5 0s5 3.5 7.5 0"
```

A bolt — a single closed silhouette, which at 16px beats any outline:

```
--glyph "M13 2L4 14h7l-1 8 9-12h-7z"
```

## When not to use `--glyph`

- The user wants **letters** → `--text`, which uses real IBM Plex outlines.
- The user has **existing artwork** → `--svg`.
- The request is pictorial ("a photorealistic owl") → say plainly that this
  draws simple geometric marks, and offer a monogram instead.
