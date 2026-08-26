import "server-only";
import { createSign } from "node:crypto";
import { config } from "./config";

/**
 * Google Sheets, read and written from a chat.
 *
 * Two access paths, because reading and writing have genuinely different requirements:
 *
 * - **Reading a public sheet needs nothing.** The `/export?format=csv` endpoint serves any
 *   link-viewable sheet, so pasting a URL works with no setup at all.
 * - **Writing needs a service account.** An API key authorises read-only access to public data
 *   and cannot write, even to a sheet shared as "anyone with the link can edit". There is no
 *   key-only write path; this is Google's rule, not a limitation of this code.
 *
 * The service account is used for reads too when configured, since it returns proper ranges and
 * tab names rather than one flat CSV.
 *
 * Signed here with `node:crypto` rather than pulling in `googleapis`, which is an enormous
 * dependency for what amounts to one JWT and three REST calls.
 */

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export class SheetsError extends Error {}

/** A spreadsheet id is a long opaque string; anything else in the URL is ignored. */
export type SheetRef = { id: string; gid: string | null };

/**
 * Accepts a pasted URL or a bare id, because people paste the whole address bar — including the
 * `#gid=0` that identifies which tab they were looking at.
 */
export const parseRef = (input: string): SheetRef => {
  const text = input.trim();

  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(text);
  const id = fromUrl?.[1] ?? (/^[a-zA-Z0-9-_]{20,}$/.test(text) ? text : null);
  if (!id) throw new SheetsError("that does not look like a Google Sheets link");

  // gid appears in the query on newer links and in the fragment on older ones.
  const gid = /[?&#]gid=(\d+)/.exec(text)?.[1] ?? null;
  return { id, gid };
};

// ── service account ──────────────────────────────────────────────────────

type Credentials = { clientEmail: string; privateKey: string };

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/** Cached until shortly before expiry: a token lasts an hour and minting one costs a round trip. */
const globalForToken = globalThis as unknown as {
  wspbotSheetsToken?: { token: string; expiresAt: number };
};

/**
 * Exchange a self-signed JWT for an access token — the service-account flow, which is just
 * RS256 over two base64url segments.
 */
const accessToken = async (credentials: Credentials): Promise<string> => {
  const cached = globalForToken.wspbotSheetsToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(credentials.privateKey, "base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new SheetsError(
      body.error_description ?? body.error ?? `Google returned ${res.status}`,
    );
  }

  globalForToken.wspbotSheetsToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
};

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const credentials = config.googleServiceAccount();
  if (!credentials) throw new SheetsError("no Google service account is configured");

  const token = await accessToken(credentials);
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string; status?: string };
  };
  if (!res.ok) {
    const message = body.error?.message ?? `Google returned ${res.status}`;
    // The single commonest failure, and the fix is not obvious from Google's wording.
    throw new SheetsError(
      res.status === 403 || res.status === 404
        ? `${message} — share the sheet with ${credentials.clientEmail} as an Editor`
        : message,
    );
  }
  return body;
};

// ── reading ──────────────────────────────────────────────────────────────

/** A grid rendered as rows of comma-joined cells: compact, and reads fine in a chat. */
const renderGrid = (rows: string[][], limit = 40): string => {
  if (rows.length === 0) return "(empty)";
  const shown = rows.slice(0, limit);
  const body = shown.map((row, i) => `${i + 1}. ${row.join(" | ")}`).join("\n");
  return rows.length > limit ? `${body}\n… and ${rows.length - limit} more rows` : body;
};

/** Minimal CSV parse: enough for quoted fields and embedded commas, which is what Sheets emits. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

/**
 * Read without credentials, using the public CSV export.
 *
 * Only works for a link-viewable sheet, and returns one tab flattened — but it needs no setup
 * at all, which is the difference between "paste a link and ask" and "first go to Google Cloud".
 */
const readPublicCsv = async (ref: SheetRef): Promise<string[][]> => {
  const url = `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv${
    ref.gid ? `&gid=${ref.gid}` : ""
  }`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new SheetsError(
      res.status === 404
        ? "that sheet does not exist, or is not shared publicly"
        : `could not read it publicly (${res.status}) — it may be private`,
    );
  }

  const text = await res.text();
  // A private sheet redirects to a sign-in page rather than returning an error status.
  if (text.trimStart().startsWith("<")) {
    throw new SheetsError(
      "that sheet is not public. Either share it for viewing, or share it with the service account.",
    );
  }
  return parseCsv(text);
};

export const read = async (
  input: string,
  range?: string,
): Promise<{ text: string; viaServiceAccount: boolean }> => {
  const ref = parseRef(input);

  if (config.googleServiceAccount()) {
    const target = range?.trim() || (await firstSheetName(ref));
    const body = await api<{ values?: string[][] }>(
      `/${ref.id}/values/${encodeURIComponent(target)}`,
    );
    return { text: renderGrid(body.values ?? []), viaServiceAccount: true };
  }

  return { text: renderGrid(await readPublicCsv(ref)), viaServiceAccount: false };
};

type SheetProperties = { properties?: { title?: string; sheetId?: number } };

const spreadsheet = (id: string) =>
  api<{ properties?: { title?: string }; sheets?: SheetProperties[] }>(
    `/${id}?fields=properties.title,sheets.properties.title,sheets.properties.sheetId`,
  );

/** The tab someone was looking at when they copied the link, or the first one. */
const firstSheetName = async (ref: SheetRef): Promise<string> => {
  const info = await spreadsheet(ref.id);
  const tabs = info.sheets ?? [];
  const match = ref.gid
    ? tabs.find((s) => String(s.properties?.sheetId) === ref.gid)
    : undefined;
  return match?.properties?.title ?? tabs[0]?.properties?.title ?? "Sheet1";
};

export const describe = async (input: string): Promise<string> => {
  const ref = parseRef(input);
  if (!config.googleServiceAccount()) {
    const rows = await readPublicCsv(ref);
    return `Read publicly, one tab only. ${rows.length} rows.\n\n${renderGrid(rows, 10)}`;
  }
  const info = await spreadsheet(ref.id);
  const tabs = (info.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter(Boolean)
    .join(", ");
  return `"${info.properties?.title ?? "Untitled"}" — tabs: ${tabs || "(none)"}`;
};

// ── writing ──────────────────────────────────────────────────────────────

/**
 * `USER_ENTERED` so a typed "=SUM(A1:A9)" becomes a formula and "5" becomes a number, exactly
 * as if a person had typed it. `RAW` would store the literal text and surprise everyone.
 */
const VALUE_INPUT = "USER_ENTERED";

export const update = async (
  input: string,
  range: string,
  values: string[][],
): Promise<string> => {
  const ref = parseRef(input);
  const body = await api<{ updatedCells?: number; updatedRange?: string }>(
    `/${ref.id}/values/${encodeURIComponent(range)}?valueInputOption=${VALUE_INPUT}`,
    { method: "PUT", body: JSON.stringify({ values }) },
  );
  return `Updated ${body.updatedCells ?? 0} cell(s) in ${body.updatedRange ?? range}.`;
};

export const append = async (
  input: string,
  values: string[][],
  range?: string,
): Promise<string> => {
  const ref = parseRef(input);
  const target = range?.trim() || (await firstSheetName(ref));
  const body = await api<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
    `/${ref.id}/values/${encodeURIComponent(target)}:append?valueInputOption=${VALUE_INPUT}&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values }) },
  );
  return `Added ${body.updates?.updatedRows ?? values.length} row(s) at ${body.updates?.updatedRange ?? target}.`;
};
