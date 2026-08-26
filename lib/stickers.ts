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

/**
 * The sticker library.
 *
 * People send stickers; the bot quietly keeps them so it can send them back later. Three things
 * make that harder than it sounds:
 *
 * 1. Inbound media is encrypted. The webhook carries a CDN link and a key, not usable bytes.
 * 2. Decryption gives a URL that dies after an hour, so anything kept must be re-uploaded.
 * 3. The bot cannot "see" its library at send time, so each sticker is described once on
 *    arrival and chosen later by that description.
 *
 * Bytes are hashed so the same sticker — and they repeat constantly — is uploaded and described
 * exactly once, no matter how often it is sent.
 */

/** Scoped per chat, like memories: an in-joke from one group has no business in another. */
export type Sticker = {
  id: string;
  chat: string;
  url: string;
  label: string;
  description: string | null;
  addedBy: string | null;
};

type Row = {
  id: number;
  chat: string;
  sha256: string;
  url: string;
  label: string;
  description: string | null;
  added_by: string | null;
};

const toSticker = (row: Row): Sticker => ({
  id: `s${row.id}`,
  chat: row.chat,
  url: row.url,
  label: row.label,
  description: row.description,
  addedBy: row.added_by,
});

/** Enough for the model to choose from without crowding the prompt. */
const LIST_LIMIT = 40;

/** Refuse anything implausible for a sticker before spending an upload and a vision call. */
const MAX_BYTES = 2 * 1024 * 1024;

export const list = async (chat: string): Promise<Sticker[]> => {
  const rows = await query<Row>(
    "select * from stickers where chat = $1 order by id desc limit $2",
    [chat, LIST_LIMIT],
  );
  return rows.map(toSticker);
};

export const byId = async (id: string, chat: string): Promise<Sticker | null> => {
  const digits = /^s?(\d+)$/.exec(id.trim());
  if (!digits?.[1]) return null;
  const rows = await query<Row>(
    "select * from stickers where id = $1 and chat = $2",
    [Number(digits[1]), chat],
  );
  return rows[0] ? toSticker(rows[0]) : null;
};

export const remove = async (id: string, chat: string): Promise<Sticker | null> => {
  const digits = /^s?(\d+)$/.exec(id.trim());
  if (!digits?.[1]) return null;
  const rows = await query<Row>(
    "delete from stickers where id = $1 and chat = $2 returning *",
    [Number(digits[1]), chat],
  );
  return rows[0] ? toSticker(rows[0]) : null;
};

/** Rendered into the system prompt so the model can pick one without a lookup round-trip. */
export const render = (stickers: Sticker[]): string =>
  stickers.length === 0
    ? "(no stickers saved in this chat yet)"
    : stickers
        .map((s) => `- [${s.id}] ${s.label}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n");

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
    const { object } = await generateObject({
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
 * Upload, describe and record one finished sticker, reusing prior work when the same bytes
 * have been seen before. Returns the row, or null if an identical sticker already existed.
 */
const store = async (
  chat: string,
  senderName: string,
  bytes: Buffer,
  describeFrom: Buffer,
  presetLabel?: string,
): Promise<{ sticker: Sticker; isNew: boolean } | null> => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const already = await query<Row>(
    "select * from stickers where chat = $1 and sha256 = $2",
    [chat, sha256],
  );
  if (already[0]) return { sticker: toSticker(already[0]), isNew: false };

  /**
   * Seen in another chat: reuse its permanent URL and description rather than paying for the
   * upload and the vision call again. Only the row is per-chat, not the work.
   */
  const elsewhere = await query<Row>(
    "select * from stickers where sha256 = $1 limit 1",
    [sha256],
  );

  const { url, label, description } = elsewhere[0]
    ? {
        url: elsewhere[0].url,
        label: elsewhere[0].label,
        description: elsewhere[0].description,
      }
    : await (async () => {
        // The decrypted URL expires in an hour, so the bytes need a permanent home.
        const uploaded = await wapi.upload({
          base64: bytes.toString("base64"),
          mimetype: "image/webp",
          fileName: "sticker.webp",
        });
        const described = presetLabel
          ? { label: presetLabel, description: null as string | null }
          : await describe(describeFrom);
        return { url: uploaded, ...described };
      })();

  const inserted = await query<Row>(
    `insert into stickers (chat, sha256, url, label, description, added_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (chat, sha256) do nothing
     returning *`,
    [chat, sha256, url, label, description, senderName],
  );

  if (!inserted[0]) return null; // Lost a race with a concurrent delivery; already stored.
  console.log(`[stickers] saved [${inserted[0].id}] ${label} from ${senderName}`);
  return { sticker: toSticker(inserted[0]), isNew: true };
};

/**
 * Build a sticker out of an image, GIF or video the person attached, then store it.
 *
 * Unlike `capture` this one throws: it runs from a tool call, and the person asked for it, so
 * a failure needs to reach them rather than disappear into a log.
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

  const result = await store(chat, senderName, webp, forDescription, label);
  if (!result) throw new StickerError("could not save the sticker");
  return result.sticker;
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
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      console.warn(`[stickers] skipping, ${bytes.length} bytes`);
      return null;
    }

    const result = await store(chat, senderName, bytes, bytes);
    return result?.sticker ?? null;
  } catch (err) {
    console.error("[stickers] capture failed:", err instanceof Error ? err.message : err);
    return null;
  }
};
