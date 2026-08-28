/**
 * Is the text on the landing page actually readable?
 *
 * This exists because the answer was no, twice, in the same file, for the same reason — and
 * neither time did anything notice. The rule `.lp a { color: inherit }` has specificity (0,1,1),
 * which quietly outranks a bare `.lp-btn { color: … }` at (0,1,0). The button therefore kept its
 * gold background and inherited near-white text: **1.4:1**, unreadable, while the CSS said
 * exactly the right thing a few lines below.
 *
 * So checking the declared pairs is not enough. This resolves the cascade for a handful of named
 * elements the way a browser would — every rule that could match, ordered by specificity and then
 * by source order — and measures the winner. It is a small subset of CSS (descendant combinators
 * of classes, element names and pseudo-classes), which is all this stylesheet uses.
 *
 * Needs nothing. Run it after touching app/landing.css.
 *
 *   npm run contrast-check
 */

import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/landing.css", import.meta.url), "utf8")
  // Comments can contain braces and colons, which would otherwise be read as rules.
  .replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; decls: Record<string, string>; order: number };

/** Flat parse. Nested at-rules are skipped: nothing inside them sets a colour here. */
const rules: Rule[] = [];
let order = 0;
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selectorText = (match[1] ?? "").trim();
  if (!selectorText || selectorText.startsWith("@") || selectorText.startsWith("%")) continue;
  const decls: Record<string, string> = {};
  for (const decl of (match[2] ?? "").split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    decls[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  for (const selector of selectorText.split(",")) {
    rules.push({ selector: selector.trim(), decls, order: order++ });
  }
}

/** (ids, classes+pseudo-classes+attributes, elements) — the standard three. */
const specificity = (selector: string): [number, number, number] => {
  const clean = selector.replace(/::[a-z-]+/g, "");
  return [
    (clean.match(/#[\w-]+/g) ?? []).length,
    (clean.match(/\.[\w-]+/g) ?? []).length + (clean.match(/:(?!:)[a-z-]+/g) ?? []).length,
    (clean.match(/(^|[\s>+~])[a-z]+/g) ?? []).length,
  ];
};

const beats = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/** One element, described as the chain of things it sits inside. */
type Element = { name: string; element: string; classes: string[]; ancestors: string[] };

/**
 * Does this selector match? Every compound in the selector must be satisfied, the last by the
 * element itself and the earlier ones by something it is inside. `:hover` and the like are
 * ignored — the resting state is what has to be readable.
 */
const matches = (selector: string, el: Element): boolean => {
  const compounds = selector.split(/\s+/).filter(Boolean);
  const last = compounds[compounds.length - 1];
  if (!last) return false;

  const satisfies = (compound: string, name: string, classes: string[]): boolean => {
    const bare = compound.replace(/:(?!:)[a-z-]+/g, "").replace(/::[a-z-]+/g, "");
    const wanted = (bare.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
    const tag = bare.replace(/\.[\w-]+/g, "").trim();
    if (tag && tag !== "*" && tag !== name) return false;
    return wanted.every((c) => classes.includes(c));
  };

  if (!satisfies(last, el.element, el.classes)) return false;

  // Ancestors, in order, each matched by something further out in the chain.
  let cursor = el.ancestors.length - 1;
  for (let i = compounds.length - 2; i >= 0; i--) {
    const compound = compounds[i] as string;
    let found = false;
    while (cursor >= 0) {
      const a = el.ancestors[cursor] as string;
      cursor--;
      const classes = (a.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
      const tag = a.replace(/\.[\w-]+/g, "").trim();
      if (satisfies(compound, tag || "div", classes)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
};

/** The value that actually wins for one property, or undefined. */
const resolve = (el: Element, property: string): string | undefined => {
  let winner: Rule | undefined;
  let best: [number, number, number] = [-1, -1, -1];
  for (const rule of rules) {
    if (rule.decls[property] === undefined) continue;
    // The resting state only; a hover colour is not what someone reads.
    if (/:(hover|focus|active)/.test(rule.selector)) continue;
    if (!matches(rule.selector, el)) continue;
    const spec = specificity(rule.selector);
    if (winner === undefined || beats(spec, best) || (!beats(best, spec) && rule.order > winner.order)) {
      winner = rule;
      best = spec;
    }
  }
  return winner?.decls[property];
};

/** The palette, read from the `.lp` block so it cannot drift from the stylesheet. */
const tokens: Record<string, string> = {};
for (const rule of rules) {
  if (rule.selector !== ".lp") continue;
  for (const [k, v] of Object.entries(rule.decls)) {
    if (k.startsWith("--")) tokens[k] = v;
  }
}

const literal = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const v = value.trim();
  const varMatch = /^var\((--[\w-]+)\)$/.exec(v);
  if (varMatch) return tokens[varMatch[1] as string];
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined;
};

const srgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
};

const luminance = (hex: string): number => {
  const [r, g, b] = srgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
};

const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return ((x as number) + 0.05) / ((y as number) + 0.05);
};

/**
 * What someone actually reads. Each carries the background it sits on, since a transparent
 * element inherits its parent's — which no amount of parsing will tell you.
 */
const ELEMENTS: (Element & { on: string; min: number })[] = [
  {
    name: "primary CTA — Open the dashboard",
    element: "a",
    classes: ["lp-btn"],
    ancestors: [".lp", ".lp-hero", ".lp-hero-copy", ".lp-actions"],
    on: "--gold",
    min: 4.5,
  },
  {
    name: "secondary CTA — Read the source",
    element: "a",
    classes: ["lp-btn", "ghost"],
    ancestors: [".lp", ".lp-hero", ".lp-hero-copy", ".lp-actions"],
    on: "--obsidian",
    min: 4.5,
  },
  {
    name: "nav sign-in pill",
    element: "a",
    classes: ["lp-signin"],
    ancestors: [".lp", ".lp-nav", "nav"],
    on: "--obsidian",
    min: 4.5,
  },
  {
    name: "nav source link",
    element: "a",
    classes: [],
    ancestors: [".lp", ".lp-nav", "nav"],
    on: "--obsidian",
    min: 4.5,
  },
  {
    name: "body copy under the headline",
    element: "p",
    classes: ["lp-sub"],
    ancestors: [".lp", ".lp-hero", ".lp-hero-copy"],
    on: "--obsidian",
    min: 4.5,
  },
  {
    name: "capability card body",
    element: "p",
    classes: [],
    ancestors: [".lp", ".lp-section", ".lp-grid", "li"],
    on: "--titanium",
    min: 4.5,
  },
  {
    name: "footer text",
    element: "span",
    classes: [],
    ancestors: [".lp", ".lp-footer"],
    on: "--obsidian",
    min: 4.5,
  },
];

let failures = 0;
console.log("\ncontrast (resting state, resolved through the cascade):\n");

for (const el of ELEMENTS) {
  // Colour is inherited, so walk out through the ancestors until something sets it.
  let colour = literal(resolve(el, "color"));
  if (!colour) {
    for (let i = el.ancestors.length - 1; i >= 0 && !colour; i--) {
      const a = el.ancestors[i] as string;
      colour = literal(
        resolve(
          {
            name: a,
            element: a.replace(/\.[\w-]+/g, "").trim() || "div",
            classes: (a.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1)),
            ancestors: el.ancestors.slice(0, i),
          },
          "color",
        ),
      );
    }
  }
  const background = tokens[el.on];

  if (!colour || !background) {
    failures++;
    console.log(`  FAIL ${el.name} — could not resolve ${!colour ? "a colour" : "a background"}`);
    continue;
  }

  const r = ratio(colour, background);
  const pass = r >= el.min;
  if (!pass) failures++;
  console.log(
    `  ${pass ? "PASS" : "FAIL"} ${el.name.padEnd(34)} ${colour} on ${background}  ${r.toFixed(2)}:1`,
  );
}

console.log(failures === 0 ? "\nall readable\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
