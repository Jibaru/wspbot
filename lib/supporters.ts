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
  /**
   * Every WhatsApp identity known to be this person, normalised.
   *
   * Several, because WhatsApp gives one human a phone JID, a LID and a username, and none is
   * derivable from the others — wapi maps phone to LID and back, and nothing resolves a username
   * at all. Recording only one means whichever the bot happens to see never matches.
   *
   * Empty when nobody has tied them to an identity yet, which is why they cannot vote.
   */
  handles: string[];
  via: Via;
  note: string | null;
  /**
   * How much they have chipped in, as a count rather than money — which is what keeps the
   * promise this list makes. Buy Me a Coffee supplies it; a Yape gift is converted by hand,
   * because the conversion is a judgement and not an exchange rate.
   */
  coffees: number;
  since: Date;
};

type Row = {
  id: number;
  name: string;
  handles: string[] | null;
  via: string;
  note: string | null;
  coffees: number;
  since: Date;
};

const toSupporter = (row: Row): Supporter => ({
  id: row.id,
  name: row.name,
  handles: row.handles ?? [],
  via: (["yape", "coffee", "code", "other"].includes(row.via) ? row.via : "other") as Via,
  note: row.note,
  coffees: row.coffees,
  since: row.since,
});

/**
 * The most a single person's vote can be worth.
 *
 * Gratitude is uncapped — the list keeps showing the true count — but influence saturates, so one
 * person buying fifty coffees cannot own the roadmap outright. A flat cap rather than a square
 * root because "your vote counts as five, the most anyone gets" is a sentence somebody can say in
 * a group chat, and the square root of seventeen is not.
 */
export const MAX_WEIGHT = 5;

/**
 * What one person's vote is worth. The only place this arithmetic happens — three copies of
 * `Math.min` is how a tally and a cap check start disagreeing.
 *
 * Pure, so the check drives it without a database.
 */
export const weightFor = (supporter: Supporter | null | undefined): number =>
  supporter ? Math.min(Math.max(supporter.coffees, 0), MAX_WEIGHT) : 0;

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

/** The identities come back as an array so one supporter stays one row. */
const SELECT = `
  select s.id, s.name, s.via, s.note, s.coffees, s.since,
         array_remove(array_agg(h.handle order by h.handle), null) as handles
    from supporters s
    left join supporter_handles h on h.supporter_id = s.id
   group by s.id`;

export const list = async (): Promise<Supporter[]> => {
  const rows = await query<Row>(`${SELECT} order by s.since desc, s.id desc`);
  return rows.map(toSupporter);
};

/**
 * Several identities at once, separated by commas, semicolons or newlines — **not** spaces.
 *
 * A space is far likelier to be inside one identity than between two: "+51 999 888 777" is how a
 * person writes a phone number, and splitting on whitespace turned it into four identities, none
 * of which matched anything. Comma-separated is what the field asks for.
 */
export const parseHandles = (input: string | null | undefined): string[] =>
  input ? [...new Set(input.split(/[,;\n]+/).map(normalise).filter(Boolean))] : [];

export const add = async (input: {
  name: string;
  handles?: string | string[] | null;
  via: Via;
  note?: string | null;
  coffees?: number;
  externalId?: string | null;
  since?: Date;
}): Promise<void> => {
  const rows = await query<{ id: number }>(
    `insert into supporters (name, via, note, coffees, external_id, since)
     values ($1, $2, $3, $4, $5, coalesce($6, now()))
     on conflict (via, external_id) where external_id is not null do nothing
     returning id`,
    [
      input.name.trim(),
      input.via,
      input.note?.trim() || null,
      Math.max(1, Math.floor(input.coffees ?? 1)),
      input.externalId ?? null,
      input.since ?? null,
    ],
  );

  // No row means the external id was already there, and its identities are not ours to overwrite.
  const id = rows[0]?.id;
  if (id === undefined) return;

  const wanted = Array.isArray(input.handles)
    ? input.handles.map(normalise).filter(Boolean)
    : parseHandles(input.handles);
  for (const handle of wanted) await tie(id, handle);
};

/**
 * Claim one identity for a supporter.
 *
 * An identity belongs to exactly one person — the primary key says so — and a conflict moves it
 * rather than failing, because the common case is fixing a mistake rather than a collision.
 */
export const tie = async (supporterId: number, handle: string): Promise<void> => {
  const key = normalise(handle);
  if (!key) return;
  await query(
    `insert into supporter_handles (handle, supporter_id) values ($1, $2)
     on conflict (handle) do update set supporter_id = excluded.supporter_id`,
    [key, supporterId],
  );
};

export const untie = (handle: string): Promise<unknown[]> =>
  query("delete from supporter_handles where handle = $1", [normalise(handle)]);

export const update = async (
  id: number,
  input: { name: string; handles: string | null; note: string | null; coffees: number },
): Promise<void> => {
  await query("update supporters set name = $2, note = $3, coffees = $4 where id = $1", [
    id,
    input.name.trim(),
    input.note?.trim() || null,
    Math.max(1, Math.floor(input.coffees)),
  ]);

  /*
   * The field is the whole set, so anything removed from it is untied. Scoped to this supporter,
   * so editing one person can never strip an identity from somebody else.
   */
  const wanted = parseHandles(input.handles);
  await query(
    `delete from supporter_handles where supporter_id = $1 and not (handle = any($2))`,
    [id, wanted],
  );
  for (const handle of wanted) await tie(id, handle);
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

  const rows = await query<{ handle: string }>("select handle from supporter_handles");
  const handles = new Set(rows.map((r) => r.handle));
  cached = { handles, at: now };
  return handles;
};

/**
 * One supporter by any of their identities. What a vote consults to find its weight, and the
 * reason a person recognised by their LID in one group is the same person as their username.
 */
export const byHandle = async (handle: string): Promise<Supporter | null> => {
  const key = normalise(handle);
  if (!key) return null;
  const rows = await query<Row>(
    `${SELECT} having bool_or(h.handle = $1)`,
    [key],
  );
  return rows[0] ? toSupporter(rows[0]) : null;
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

export type CoffeeSupporter = {
  externalId: string;
  name: string;
  at: Date | null;
  coffees: number;
};

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
      const coffees = Number(row["support_coffees"]);
      found.push({
        externalId,
        name,
        at: at && !Number.isNaN(at.getTime()) ? at : null,
        coffees: Number.isFinite(coffees) && coffees > 0 ? Math.floor(coffees) : 1,
      });
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
      coffees: s.coffees,
      ...(s.at ? { since: s.at } : {}),
    });
    added++;
  }

  forget();
  return { added, seen: found.length };
};
