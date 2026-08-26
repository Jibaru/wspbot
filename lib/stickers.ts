import "server-only";
import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "./config";
import { query } from "./db";
import { wapi } from "./wapi";
// Aliased: `toSticker` here already means "database row -> Sticker".
import { toSticker as encodeSticker, firstFrame, StickerError } from "./sticker-maker";
import type { Media } from "./mentions";
import { fetchMedia, looksAnimated } from "./fetch-media";
import * as usage from "./usage";

/**
 * The sticker library — one shared collection, used by every chat.
 *
 * Three things make collecting stickers harder than it sounds:
 *
 * 1. Inbound media is encrypted. The webhook carries a CDN link and a key, not usable bytes.
 * 2. Decryption gives a URL that dies after an hour, so anything kept must be re-uploaded.
 * 3. The bot cannot "see" its library at send time, so each sticker is described once on
 *    arrival and chosen later by that description.
 *
 * A sticker's identity is the sha256 of its bytes, so the same one is uploaded and described
 * exactly once no matter how often, or where, it is sent.
 *
 * The bytes are kept in the database as well as on wapi. That is what makes the library survive
 * a change of number: a new number means a new session, and nothing promises the old upload
 * URLs outlive it — but a sticker whose bytes are held here can simply be uploaded again.
 */

export type Sticker = {
  id: string;
  /** Where it was first seen. Provenance only — every chat can use every sticker. */
  chat: string;
  url: string;
  /** The name. Auto-generated on arrival, and renameable afterwards. */
  label: string;
  description: string | null;
  addedBy: string | null;
  /** Whether the bytes are held locally, and so re-uploadable if the URL dies. */
  hasBytes: boolean;
};

type Row = {
  id: number;
  chat: string;
  sha256: string;
  url: string;
  label: string;
  description: string | null;
  added_by: string | null;
  has_bytes?: boolean;
};

const toSticker = (row: Row): Sticker => ({
  id: `s${row.id}`,
  chat: row.chat,
  url: row.url,
  label: row.label,
  description: row.description,
  addedBy: row.added_by,
  hasBytes: row.has_bytes ?? false,
});

/** Never select `bytes` unless it is actually needed — the rows are hundreds of KB each. */
const COLUMNS =
  "id, chat, sha256, url, label, description, added_by, (bytes is not null) as has_bytes";

/** Enough for the model to choose from without crowding the prompt. */
const LIST_LIMIT = 60;

/** Refuse anything implausible for a sticker before spending an upload and a vision call. */
const MAX_BYTES = 2 * 1024 * 1024;

const parseId = (id: string): number | null => {
  const digits = /^s?(\d+)$/.exec(id.trim());
  return digits?.[1] ? Number(digits[1]) : null;
};

/** The whole library — shared, so there is nothing to scope by. */
export const list = async (): Promise<Sticker[]> => {
  const rows = await query<Row>(
    `select ${COLUMNS} from stickers order by id desc limit $1`,
    [LIST_LIMIT],
  );
  return rows.map(toSticker);
};

export const byId = async (id: string): Promise<Sticker | null> => {
  const numeric = parseId(id);
  if (numeric === null) return null;
  const rows = await query<Row>(`select ${COLUMNS} from stickers where id = $1`, [numeric]);
  return rows[0] ? toSticker(rows[0]) : null;
};

export const remove = async (id: string): Promise<Sticker | null> => {
  const numeric = parseId(id);
  if (numeric === null) return null;
  const rows = await query<Row>(
    `delete from stickers where id = $1 returning ${COLUMNS}`,
    [numeric],
  );
  return rows[0] ? toSticker(rows[0]) : null;
};

/** Give a sticker a name people will actually use to ask for it. */
export const rename = async (id: string, label: string): Promise<Sticker | null> => {
  const numeric = parseId(id);
  if (numeric === null) return null;
  const rows = await query<Row>(
    `update stickers set label = $2 where id = $1 returning ${COLUMNS}`,
    [numeric, label.trim()],
  );
  return rows[0] ? toSticker(rows[0]) : null;
};

/** Rendered into the system prompt so the model can pick one without a lookup round-trip. */
export const render = (stickers: Sticker[]): string =>
  stickers.length === 0
    ? "(no stickers saved yet)"
    : stickers
        .map((s) => `- [${s.id}] ${s.label}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n");

/**
 * A URL wapi can fetch right now.
 *
 * The stored URL usually works. When it does not — the likeliest reason being that the session
 * which uploaded it is gone, i.e. the number changed — the bytes held in the database are
 * uploaded again and the row repaired. This is the whole point of storing them.
 */
export const liveUrl = async (sticker: Sticker): Promise<string> => {
  const numeric = parseId(sticker.id)!;

  const reachable = await fetch(sticker.url, { method: "HEAD" })
    .then((r) => r.ok)
    .catch(() => false);
  if (reachable) return sticker.url;

  const rows = await query<{ bytes: Buffer | null }>(
    "select bytes from stickers where id = $1",
    [numeric],
  );
  const bytes = rows[0]?.bytes;
  if (!bytes) {
    throw new StickerError(
      `"${sticker.label}" is no longer hosted and there is no local copy to restore it from`,
    );
  }

  const url = await wapi.upload({
    base64: Buffer.from(bytes).toString("base64"),
    mimetype: "image/webp",
    fileName: "sticker.webp",
  });
  await query("update stickers set url = $2 where id = $1", [numeric, url]);
  console.log(`[stickers] re-uploaded ${sticker.id} after its URL went dead`);
  return url;
};

/**
 * Older rows predate local storage. Filling them in opportunistically means the library becomes
 * portable over time rather than only from here on. Failure is ignored — it is a nicety.
 */
const backfillBytes = async (sticker: Sticker): Promise<void> => {
  if (sticker.hasBytes) return;
  try {
    const res = await fetch(sticker.url);
    if (!res.ok) return;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return;
    await query("update stickers set bytes = $2 where id = $1 and bytes is null", [
      parseId(sticker.id),
      bytes,
    ]);
  } catch {
    /* opportunistic only */
  }
};

/** Fire-and-forget: never let a backfill delay or break a send. */
export const ensureStored = (sticker: Sticker): void => {
  void backfillBytes(sticker);
};

/**
 * Ask the model what the sticker shows, so it can be chosen by description later.
 *
 * Best-effort by design: an animated or unusual webp may be rejected, and a sticker with a dull
 * label is far better than a sticker the bot refuses to save.
 */
const describe = async (
  bytes: Buffer,
): Promise<{ label: string; description: string | null }> => {
  try {
    const result = await generateObject({
      model: openai(config.model()),
      schema: z.object({
        label: z
          .string()
          .describe("Two to four words naming it, e.g. 'laughing cat' or 'thumbs up'."),
        description: z
          .string()
          .describe(
            "One sentence: what is shown, the mood, and any text in the image. This is what it will be searched by.",
          ),
      }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "This is a WhatsApp sticker. Name it and describe it so someone could ask for it later by meaning — the emotion it conveys matters more than fine visual detail.",
            },
            { type: "image", image: bytes, mediaType: "image/webp" },
          ],
        },
      ],
    });
    const object = result.object;
    await usage.record({ kind: "vision", model: config.model(), usage: result.usage });
    return { label: object.label.trim(), description: object.description.trim() };
  } catch (err) {
    console.warn("[stickers] could not describe:", err instanceof Error ? err.message : err);
    return { label: "sticker", description: null };
  }
};

/** Inbound media is encrypted; this is the only way to get at the actual bytes. */
const fetchDecrypted = async (node: Record<string, unknown>): Promise<Buffer> => {
  const temporaryUrl = await wapi.decryptMedia(node);
  const res = await fetch(temporaryUrl);
  if (!res.ok) throw new Error(`fetching decrypted media failed with ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Upload, describe and record one finished sticker. A sticker already known by its bytes is
 * returned as-is — no second upload, no second vision call, no duplicate row.
 */
const store = async (
  chat: string,
  senderName: string,
  bytes: Buffer,
  describeFrom: Buffer,
  presetLabel?: string,
): Promise<Sticker> => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const already = await query<Row>(`select ${COLUMNS} from stickers where sha256 = $1`, [sha256]);
  if (already[0]) {
    const existing = toSticker(already[0]);
    // A name given explicitly now beats one guessed earlier.
    if (presetLabel && presetLabel !== existing.label) {
      return (await rename(existing.id, presetLabel)) ?? existing;
    }
    return existing;
  }

  // The decrypted URL expires in an hour, so the bytes need a permanent home.
  const url = await wapi.upload({
    base64: bytes.toString("base64"),
    mimetype: "image/webp",
    fileName: "sticker.webp",
  });

  const { label, description } = presetLabel
    ? { label: presetLabel, description: null as string | null }
    : await describe(describeFrom);

  const inserted = await query<Row>(
    `insert into stickers (chat, sha256, url, label, description, added_by, bytes)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (sha256) do nothing
     returning ${COLUMNS}`,
    [chat, sha256, url, label, description, senderName, bytes],
  );

  if (inserted[0]) {
    console.log(`[stickers] saved [${inserted[0].id}] ${label} from ${senderName}`);
    return toSticker(inserted[0]);
  }

  // Lost a race with a concurrent delivery; the winner's row is the answer.
  const raced = await query<Row>(`select ${COLUMNS} from stickers where sha256 = $1`, [sha256]);
  if (!raced[0]) throw new StickerError("could not save the sticker");
  return toSticker(raced[0]);
};

/**
 * Build a sticker out of an image, GIF or video someone attached, then store it.
 *
 * Unlike `capture` this one throws: it runs from a tool call, and the person asked for it, so a
 * failure needs to reach them rather than disappear into a log.
 */
export const createFrom = async (
  chat: string,
  senderName: string,
  media: Media,
  label?: string,
): Promise<Sticker> => {
  const source = await fetchDecrypted(media.node);
  if (source.length === 0) throw new StickerError("the attachment came back empty");

  const webp = await encodeSticker(source, media.animated);
  // Vision models cannot read animated WebP, so describe a single rendered frame instead.
  const forDescription = media.animated ? await firstFrame(source) : webp;

  return store(chat, senderName, webp, forDescription, label);
};

/**
 * Build a sticker from a URL — a GIF someone linked, or one the model found by searching.
 *
 * Whether it animates is decided from the bytes rather than the URL: plenty of CDNs serve a GIF
 * as `application/octet-stream`, and a `.gif` in a path proves nothing.
 */
export const createFromUrl = async (
  chat: string,
  senderName: string,
  url: string,
  label?: string,
): Promise<Sticker> => {
  const { bytes, contentType } = await fetchMedia(url);
  const animated = looksAnimated(bytes, contentType);

  const webp = await encodeSticker(bytes, animated);
  const forDescription = animated ? await firstFrame(bytes) : webp;

  return store(chat, senderName, webp, forDescription, label);
};

/**
 * Store a sticker that just arrived. Silent: never replies, and never throws into the webhook —
 * failing to keep a sticker must not cost the message it came with.
 */
export const capture = async (
  chat: string,
  senderName: string,
  stickerNode: Record<string, unknown>,
): Promise<Sticker | null> => {
  try {
    const bytes = await fetchDecrypted(stickerNode);
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      console.warn(`[stickers] skipping, ${bytes.length} bytes`);
      return null;
    }
    return await store(chat, senderName, bytes, bytes);
  } catch (err) {
    console.error("[stickers] capture failed:", err instanceof Error ? err.message : err);
    return null;
  }
};
