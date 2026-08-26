import "server-only";
import { wapi } from "./wapi";

/**
 * Getting at the bytes of something someone sent.
 *
 * Inbound media never arrives usable: the webhook carries a CDN link and a `mediaKey`, and the
 * file behind that link is encrypted. `decrypt-media` exchanges the message node for a URL that
 * works — and expires an hour later, which is why nothing stores it.
 *
 * Quoted media goes through exactly the same path: WhatsApp embeds a full copy of the replied-to
 * message in `contextInfo.quotedMessage`, keys and all, so a reply carries everything needed to
 * open what it points at.
 */

/** Well above any sticker or photo, well below anything that would trouble the container. */
export const MAX_INBOUND_BYTES = 8 * 1024 * 1024;

export const fetchDecrypted = async (
  node: Record<string, unknown>,
): Promise<Buffer> => {
  const temporaryUrl = await wapi.decryptMedia(node);
  const res = await fetch(temporaryUrl);
  if (!res.ok) throw new Error(`fetching decrypted media failed with ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("decrypted media was empty");
  if (bytes.length > MAX_INBOUND_BYTES) {
    throw new Error(`decrypted media is ${Math.round(bytes.length / 1024 / 1024)}MB, too large`);
  }
  return bytes;
};
