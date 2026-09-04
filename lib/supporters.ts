import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
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

/** Used by the webhook when a donation is refunded — the money came back, so the row goes. */
export const removeByExternalId = (externalId: string): Promise<unknown[]> =>
  query("delete from supporters where via = 'coffee' and external_id = $1", [externalId]);

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
 * Buy Me a Coffee's read API.
 *
 * Verified against a live account rather than guessed at: `/api/v1/supporters` answers a
 * Laravel-style paginated envelope — `data` plus `total`, `per_page`, `next_page_url` and the
 * rest — with five rows to a page. `/subscriptions` and `/extras` answer `200` with
 * `{"error": "No subscriptions"}` when there are none, which is a state rather than a failure and
 * is treated as one.
 *
 * The token is a personal access token issued at developers.buymeacoffee.com.
 */
const COFFEE_BASE = "https://developers.buymeacoffee.com/api/v1";

/** Five rows a page, so a long history would otherwise stop at the first handful. */
const MAX_PAGES = 40;

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

/**
 * Every one-off supporter, following the pagination to the end.
 *
 * `supporter_name` is what somebody typed and can be blank when they gave anonymously;
 * `payer_name` is what the payment carried, so it is the fallback rather than the first choice.
 */
export const fetchCoffee = async (): Promise<CoffeeSupporter[]> => {
  const token = config.coffeeToken();
  if (!token) throw new Error("BUYMEACOFFEE_TOKEN is not set");

  const found: CoffeeSupporter[] = [];
  let url: string | null = `${COFFEE_BASE}/supporters`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      /*
       * An unauthenticated request is answered with a redirect to their login page rather than a
       * 401, so following it would turn a bad token into a wall of HTML parsed as JSON.
       */
      redirect: "manual",
    });

    if (res.status === 301 || res.status === 302) {
      throw new Error("Buy Me a Coffee refused the token — check BUYMEACOFFEE_TOKEN");
    }
    if (!res.ok) throw new Error(`Buy Me a Coffee answered ${res.status}`);

    const body = (await res.json()) as Unknown;
    // "No supporters" arrives as a 200 with an error string. That is empty, not broken.
    if (typeof body["error"] === "string") break;

    const rows = (Array.isArray(body["data"]) ? body["data"] : []) as Unknown[];
    for (const row of rows) {
      const externalId = str(row, "support_id");
      if (!externalId) continue;
      const name = str(row, "supporter_name", "payer_name") ?? "Anonymous";
      const when = str(row, "support_created_on");
      const at = when ? new Date(when.replace(" ", "T") + "Z") : null;
      found.push({ externalId, name, at: at && !Number.isNaN(at.getTime()) ? at : null });
    }

    const next = body["next_page_url"];
    url = typeof next === "string" && next ? next : null;
  }

  return found;
};

/**
 * Did this delivery really come from Buy Me a Coffee?
 *
 * Their scheme, from the published documentation: HMAC-SHA256 over the **raw body**, keyed with
 * the per-webhook signing secret, hex-encoded, carried in `x-signature-sha256`. Compared in
 * constant time, and a length mismatch is a failed check rather than a thrown error — which is
 * what `timingSafeEqual` does on its own if you let it.
 */
export const verifySignature = (
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean => {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/**
 * One supporter out of a webhook payload.
 *
 * The envelope is `{event_id, type, live_mode, created, attempt, data}` and the fields inside
 * `data` come from their published webhook schema — `supporter_name`, `supporter_id`, and an
 * event-specific `id`. Kept next to the read client so the two cannot drift on what a supporter
 * is called.
 */
export const fromWebhook = (
  type: string,
  data: Unknown,
): { externalId: string; name: string; at: Date | null } | null => {
  const externalId = str(data, "id", "transaction_id", "supporter_id");
  if (!externalId) return null;
  return {
    externalId: `${type}:${externalId}`,
    name: str(data, "supporter_name", "payer_name") ?? "Anonymous",
    at: null,
  };
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
