import "server-only";
import { query } from "./db";
import { config } from "./config";

/**
 * Who has chipped in.
 *
 * Two ways in. Yape leaves no trace anywhere this app can reach — it is a bank transfer, and the
 * only record is a screenshot on somebody's phone — so those are entered by hand on the
 * dashboard. Buy Me a Coffee has an API, so those can be pulled.
 *
 * A supporter is optionally tied to a WhatsApp identity, which is what lets the rate-limit page
 * mark them and the bot recognise them. Tying is optional on purpose: somebody can put money in
 * without the bot ever needing to know which chat participant they are.
 */

export type Via = "yape" | "coffee" | "code" | "other";

export type Supporter = {
  id: number;
  name: string;
  /** Normalised WhatsApp identity, or null when they are not tied to one. */
  handle: string | null;
  via: Via;
  note: string | null;
  since: Date;
};

type Row = {
  id: number;
  name: string;
  handle: string | null;
  via: string;
  note: string | null;
  since: Date;
};

const toSupporter = (row: Row): Supporter => ({
  id: row.id,
  name: row.name,
  handle: row.handle,
  via: (["yape", "coffee", "code", "other"].includes(row.via) ? row.via : "other") as Via,
  note: row.note,
  since: row.since,
});

export const VIA_LABELS: Record<Via, string> = {
  yape: "Yape",
  coffee: "Buy Me a Coffee",
  code: "Code",
  other: "Other",
};

/**
 * One shape for three ways of writing the same person.
 *
 * A phone number reaches this app as a JID with a device suffix, and `mentions.identityKey`
 * reduces that to bare digits — so a phone supporter has to end up as bare digits too, or the
 * two never meet. WhatsApp usernames are newer and are not numbers at all, so those keep their
 * local part, lowercased. Everything else is left alone rather than mangled into a wrong match.
 */
export const normalise = (input: string): string => {
  const trimmed = input.trim().replace(/^@+/, "");
  if (!trimmed) return "";

  // A JID or LID: the identity is the part before the domain, and the device suffix is noise.
  const local = (trimmed.split("@")[0] ?? "").split(":")[0] ?? "";
  const digits = local.replace(/\D/g, "");

  // Long enough to be a phone number rather than a handle that happens to contain digits.
  if (digits.length >= 6 && digits.length === local.replace(/[\s+()-]/g, "").length) {
    return digits;
  }
  return local.toLowerCase();
};

export const list = async (): Promise<Supporter[]> => {
  const rows = await query<Row>(
    "select id, name, handle, via, note, since from supporters order by since desc, id desc",
  );
  return rows.map(toSupporter);
};

export const add = async (input: {
  name: string;
  handle?: string | null;
  via: Via;
  note?: string | null;
  externalId?: string | null;
  since?: Date;
}): Promise<void> => {
  const handle = input.handle ? normalise(input.handle) : null;
  await query(
    `insert into supporters (name, handle, via, note, external_id, since)
     values ($1, $2, $3, $4, $5, coalesce($6, now()))
     on conflict (via, external_id) where external_id is not null do nothing`,
    [input.name.trim(), handle || null, input.via, input.note?.trim() || null, input.externalId ?? null, input.since ?? null],
  );
};

export const update = async (
  id: number,
  input: { name: string; handle: string | null; note: string | null },
): Promise<void> => {
  await query("update supporters set name = $2, handle = $3, note = $4 where id = $1", [
    id,
    input.name.trim(),
    input.handle ? normalise(input.handle) || null : null,
    input.note?.trim() || null,
  ]);
};

export const remove = (id: number): Promise<unknown[]> =>
  query("delete from supporters where id = $1", [id]);

/**
 * The handles that belong to a supporter.
 *
 * Cached briefly: the rate-limit page and every listing wants it, and it changes about as often
 * as somebody buys a coffee.
 */
const TTL_MS = 60 * 1000;
let cached: { handles: Set<string>; at: number } | undefined;

export const handles = async (): Promise<Set<string>> => {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.handles;

  const rows = await query<{ handle: string }>(
    "select handle from supporters where handle is not null",
  );
  const handles = new Set(rows.map((r) => r.handle));
  cached = { handles, at: now };
  return handles;
};

/** Called after any change, so a new supporter is starred immediately rather than in a minute. */
export const forget = (): void => {
  cached = undefined;
};

/** Rendered for the model when somebody asks who supports this. Names only — never amounts. */
export const render = (all: Supporter[]): string => {
  if (all.length === 0) return "(nobody yet)";
  return all
    .map((s) => `- ${s.name} (${VIA_LABELS[s.via]})${s.note ? ` — ${s.note}` : ""}`)
    .join("\n");
};

/* ────────────────────────────────────────────────────────────────────────
 * Buy Me a Coffee
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Buy Me a Coffee's API is real — `/api/v1/supporters`, `/subscriptions` and `/extras` all
 * exist, while a made-up path under the same prefix 404s — and it wants a personal access token
 * created in the developer portal at developers.buymeacoffee.com.
 *
 * **The response shape here has not been verified against a live account**, because that needs a
 * token only the owner can issue. It is therefore written to tolerate variation: every field is
 * looked up under more than one plausible name and anything missing degrades to a sensible
 * default rather than throwing. `npm run coffee-check` runs it against the real API the moment a
 * token exists, which is the point at which the guesswork above stops being guesswork.
 */
const COFFEE_BASE = "https://developers.buymeacoffee.com/api/v1";

type Unknown = Record<string, unknown>;

const str = (row: Unknown, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
};

export type CoffeeSupporter = { externalId: string; name: string; at: Date | null };

/** One page of one-off supporters. Returns them raw so the caller decides what to store. */
export const fetchCoffee = async (): Promise<CoffeeSupporter[]> => {
  const token = config.coffeeToken();
  if (!token) throw new Error("BUYMEACOFFEE_TOKEN is not set");

  const res = await fetch(`${COFFEE_BASE}/supporters`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    // An unauthenticated request is answered with a redirect to their login page rather than a
    // 401, so following it would turn a bad token into a wall of HTML.
    redirect: "manual",
  });

  if (res.status === 302 || res.status === 301) {
    throw new Error("Buy Me a Coffee refused the token — check BUYMEACOFFEE_TOKEN");
  }
  if (!res.ok) {
    throw new Error(`Buy Me a Coffee answered ${res.status}`);
  }

  const body = (await res.json()) as Unknown;
  const rows = (Array.isArray(body["data"]) ? body["data"] : Array.isArray(body) ? body : []) as Unknown[];

  return rows.flatMap((row) => {
    const externalId = str(row, "support_id", "id", "payment_id");
    if (!externalId) return [];
    const name =
      str(row, "supporter_name", "payer_name", "name", "supporter_email") ?? "Anonymous";
    const when = str(row, "support_created_on", "created_on", "created_at");
    const at = when ? new Date(when) : null;
    return [{ externalId, name, at: at && !Number.isNaN(at.getTime()) ? at : null }];
  });
};

/**
 * Pull the coffee supporters in. Existing rows are left alone — the external id is unique, so a
 * second run adds only what is new, and any name or handle edited by hand on the dashboard
 * survives the next sync.
 */
export const syncCoffee = async (): Promise<{ added: number; seen: number }> => {
  const found = await fetchCoffee();
  let added = 0;

  for (const s of found) {
    const before = await query<{ id: number }>(
      "select id from supporters where via = 'coffee' and external_id = $1",
      [s.externalId],
    );
    if (before.length > 0) continue;
    await add({
      name: s.name,
      via: "coffee",
      externalId: s.externalId,
      ...(s.at ? { since: s.at } : {}),
    });
    added++;
  }

  forget();
  return { added, seen: found.length };
};
