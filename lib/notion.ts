import "server-only";
import { config } from "./config";
import { encodeState as sealState } from "./oauth-state";
import { query } from "./db";

/**
 * Notion, connected per chat through OAuth.
 *
 * Someone asks the bot to connect, gets a link, and picks on Notion's own consent screen exactly
 * which pages the integration may touch. That consent screen is the real access control here —
 * the bot can reach precisely what was shared with it and nothing else in the workspace.
 *
 * The connection belongs to the **chat**, not the person, because the bot acts on behalf of a
 * conversation: anyone in that room can then ask it to read or write the shared pages. That is
 * the point in a group, and it is also the thing to be aware of before connecting a private
 * workspace to a busy group.
 */

/** Pinned deliberately: Notion versions by date, and a silent bump can change response shapes. */
const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";


export class NotionError extends Error {}

export type Connection = {
  chat: string;
  accessToken: string;
  refreshToken: string | null;
  workspaceName: string | null;
  connectedBy: string | null;
};

type Row = {
  chat: string;
  access_token: string;
  refresh_token: string | null;
  workspace_name: string | null;
  connected_by: string | null;
};

const toConnection = (row: Row): Connection => ({
  chat: row.chat,
  accessToken: row.access_token,
  refreshToken: row.refresh_token,
  workspaceName: row.workspace_name,
  connectedBy: row.connected_by,
});

export const redirectUri = (): string => `${config.appUrl()}/api/notion/callback`;

// ── the OAuth state ──────────────────────────────────────────────────────

/**
 * Signed with the Notion client secret: it is already a secret this deployment holds, and it is
 * the one tied to this particular integration, so a state issued for one integration cannot be
 * replayed against another.
 */
export { encodeState, decodeState } from "./oauth-state";

/** The link the bot sends. Notion shows the workspace and page picker behind it. */
export const authorizeUrl = (chat: string): string => {
  const notion = config.notion();
  if (!notion) throw new NotionError("Notion is not configured on this deployment");

  const url = new URL(`${API}/oauth/authorize`);
  url.searchParams.set("client_id", notion.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", sealState(chat, notion.clientSecret));
  return url.toString();
};

// ── tokens ───────────────────────────────────────────────────────────────

type TokenResponse = {
  access_token: string;
  refresh_token?: string | null;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  error?: string;
  error_description?: string;
};

/** Token endpoint takes the client credentials as HTTP Basic, not in the body. */
const tokenRequest = async (body: Record<string, string>): Promise<TokenResponse> => {
  const notion = config.notion();
  if (!notion) throw new NotionError("Notion is not configured on this deployment");

  const basic = Buffer.from(`${notion.clientId}:${notion.clientSecret}`).toString("base64");
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new NotionError(
      json.error_description ?? json.error ?? `Notion returned ${res.status}`,
    );
  }
  return json;
};

/** Exchange the one-time code from the callback, and record the connection for that chat. */
export const completeConnection = async (
  code: string,
  chat: string,
): Promise<Connection> => {
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });

  const rows = await query<Row>(
    `insert into notion_connections
       (chat, access_token, refresh_token, workspace_id, workspace_name, bot_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (chat) do update set
       access_token   = excluded.access_token,
       refresh_token  = excluded.refresh_token,
       workspace_id   = excluded.workspace_id,
       workspace_name = excluded.workspace_name,
       bot_id         = excluded.bot_id,
       connected_at   = now()
     returning chat, access_token, refresh_token, workspace_name, connected_by`,
    [
      chat,
      token.access_token,
      token.refresh_token ?? null,
      token.workspace_id ?? null,
      token.workspace_name ?? null,
      token.bot_id ?? null,
    ],
  );
  return toConnection(rows[0]!);
};

export const connectionFor = async (chat: string): Promise<Connection | null> => {
  const rows = await query<Row>(
    "select chat, access_token, refresh_token, workspace_name, connected_by from notion_connections where chat = $1",
    [chat],
  );
  return rows[0] ? toConnection(rows[0]) : null;
};

export const disconnect = async (chat: string): Promise<boolean> => {
  const rows = await query("delete from notion_connections where chat = $1 returning chat", [
    chat,
  ]);
  return rows.length > 0;
};

// ── the API ──────────────────────────────────────────────────────────────

/**
 * One request, refreshing once if the token has expired.
 *
 * Notion tokens have historically not expired, but a refresh token is now issued, so the
 * possibility is handled rather than assumed away — an integration that silently stops working
 * after months is a miserable thing to debug.
 */
const request = async <T>(
  connection: Connection,
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401 && !retried && connection.refreshToken) {
    const token = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    });
    await query(
      "update notion_connections set access_token = $2, refresh_token = coalesce($3, refresh_token) where chat = $1",
      [connection.chat, token.access_token, token.refresh_token ?? null],
    );
    return request<T>(
      { ...connection, accessToken: token.access_token },
      path,
      init,
      true,
    );
  }

  const json = (await res.json().catch(() => ({}))) as T & { message?: string; code?: string };
  if (!res.ok) {
    throw new NotionError(
      json.message ?? `Notion returned ${res.status}${json.code ? ` (${json.code})` : ""}`,
    );
  }
  return json;
};

type RichText = { plain_text?: string };
type NotionPage = {
  id: string;
  url?: string;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
};

/**
 * A page's title lives in whichever property has type `title`, and that property can be named
 * anything — "Name" in a database, "title" on a plain page. Scanning by type is the only way
 * that works for both.
 */
const titleOf = (page: NotionPage): string => {
  for (const property of Object.values(page.properties ?? {})) {
    if (property?.type === "title") {
      const text = (property.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "Untitled";
};

export type PageRef = { id: string; title: string; url?: string };

export const search = async (
  connection: Connection,
  queryText: string,
  limit = 10,
): Promise<PageRef[]> => {
  const body = await request<{ results?: NotionPage[] }>(connection, "/search", {
    method: "POST",
    body: JSON.stringify({
      ...(queryText.trim() ? { query: queryText.trim() } : {}),
      // Pages only: data sources are a different shape and not what anyone means here.
      filter: { property: "object", value: "page" },
      page_size: Math.min(limit, 25),
    }),
  });

  return (body.results ?? []).map((page) => ({
    id: page.id,
    title: titleOf(page),
    ...(page.url ? { url: page.url } : {}),
  }));
};

type Block = Record<string, unknown> & { type?: string; has_children?: boolean };

const plain = (rich: unknown): string =>
  Array.isArray(rich) ? rich.map((r) => (r as RichText).plain_text ?? "").join("") : "";

/** Enough of a page to answer questions about it, without pulling a whole wiki into the prompt. */
const MAX_BLOCKS = 60;

/** Renders the block types people actually write in, and names the rest rather than dropping it. */
export const readPage = async (
  connection: Connection,
  pageId: string,
): Promise<string> => {
  const body = await request<{ results?: Block[] }>(
    connection,
    `/blocks/${encodeURIComponent(pageId)}/children?page_size=${MAX_BLOCKS}`,
  );

  const lines = (body.results ?? []).map((block) => {
    const type = block.type ?? "";
    const content = block[type] as Record<string, unknown> | undefined;
    const text = plain(content?.["rich_text"]);
    switch (type) {
      case "heading_1":
        return `# ${text}`;
      case "heading_2":
        return `## ${text}`;
      case "heading_3":
        return `### ${text}`;
      case "bulleted_list_item":
        return `- ${text}`;
      case "numbered_list_item":
        return `1. ${text}`;
      case "to_do":
        return `[${content?.["checked"] ? "x" : " "}] ${text}`;
      case "quote":
        return `> ${text}`;
      case "code":
        return `\`\`\`\n${text}\n\`\`\``;
      case "child_page":
        return `(sub-page: ${String(content?.["title"] ?? "untitled")})`;
      case "divider":
        return "---";
      default:
        return text || (type ? `(${type})` : "");
    }
  });

  const rendered = lines.filter(Boolean).join("\n").trim();
  return rendered || "(this page is empty)";
};

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: chunk.slice(0, 1900) } }] },
    }));

export const appendToPage = async (
  connection: Connection,
  pageId: string,
  text: string,
): Promise<void> => {
  const children = paragraphs(text);
  if (children.length === 0) throw new NotionError("there was nothing to write");
  await request(connection, `/blocks/${encodeURIComponent(pageId)}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children }),
  });
};

export const createPage = async (
  connection: Connection,
  parentPageId: string,
  title: string,
  body?: string,
): Promise<PageRef> => {
  const page = await request<NotionPage>(connection, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: title.slice(0, 200) } }] },
      },
      ...(body?.trim() ? { children: paragraphs(body) } : {}),
    }),
  });
  return { id: page.id, title, ...(page.url ? { url: page.url } : {}) };
};
